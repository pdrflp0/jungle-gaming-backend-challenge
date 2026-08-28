import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { DeleteMessageCommand, PurgeQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { WAGER_TRANSACTION_EVENTS_QUEUE_NAME } from '../messaging/outbox-publisher';
import { AppInstance, requireFreePorts, spawnAppInstance } from './spawn-app-instance';
import { createSqsClient, resolveQueueUrl } from './sqs-client';
import { waitFor } from './sqs-test-helpers';

/**
 * CHALLENGE.md secao 13: "reinicio do servico com comprovacao da
 * consistencia final" — e secao 11 ("o processo morre antes de publicar;
 * outra instancia assume o trabalho"). Os testes de rollback forcado
 * existentes (outbox-publisher.integration.ts,
 * retry-pending-reference.integration.ts) ja provam atomicidade dentro de
 * UMA transacao SQL, e que um OBJETO novo (`new OutboxPublisherWorker(...)`)
 * retoma o trabalho — mas o processo do SO nunca morre de verdade ali. Este
 * arquivo fecha essa lacuna: um processo real e morto com SIGKILL (queda
 * abrupta, sem nenhum shutdown hook rodando) depois de ja ter commitado
 * trabalho financeiro real mas ANTES de qualquer worker em background
 * drena-lo; um segundo processo real sobe e prova a consistencia final.
 *
 * Decisao deliberada de escopo: nao tentamos matar o processo NO MEIO de uma
 * transacao SQL — a janela e de microssegundos, mirar nisso de fora do
 * processo via timing de sinal do SO seria inerentemente flaky, alem de
 * exigir instrumentar o codigo financeiro so para o teste (proibido para
 * este bloco). Essa garantia ("nunca fica meio aplicado") ja esta provada
 * pelos testes de rollback forcado citados acima — o Postgres desfaz sozinho
 * uma transacao cuja conexao morre no meio dela. O que ESTE teste prova, que
 * nenhum outro prova, e especificamente o cenario da secao 11: trabalho ja
 * COMMITADO e ainda nao publicado sobrevive a morte do processo que o
 * commitou, e um processo novo o conclui.
 *
 * So HTTP e usado para semear e resolver o trabalho — por isso o consumidor
 * SQS de entrada fica desligado nas duas instancias (nenhuma mensagem de
 * `wager-transactions.fifo` entra neste cenario). O processo reiniciado liga
 * so os workers realmente necessarios para concluir o trabalho pendente:
 * publisher da Outbox e worker de PENDING_REFERENCE.
 *
 * Deliberadamente lento (dois boots completos da aplicacao Nest, em
 * sequencia) — mora em `test:concurrency:processes`, nunca em
 * `test:concurrency` nem em `bun test`. Sem sufixo .spec./.test. de proposito.
 */

const INSTANCE_1_PORT = 3401;
const INSTANCE_2_PORT = 3402;

interface OpenWalletBody {
  id: string;
}
interface SubmitBody {
  transactionId: string;
  status: string;
}
interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  published_at: string | null;
}
interface ReceivedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  data: Record<string, unknown>;
}

let orm: MikroORM;
let eventsClient: SQSClient;
let eventsQueueUrl: string;

async function truncateAll(): Promise<void> {
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
}

beforeAll(async () => {
  await requireFreePorts([INSTANCE_1_PORT, INSTANCE_2_PORT]);
  orm = await MikroORM.init(config);
  await truncateAll();
  eventsClient = createSqsClient();
  eventsQueueUrl = await resolveQueueUrl(eventsClient, WAGER_TRANSACTION_EVENTS_QUEUE_NAME);
  await eventsClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }));
}, 30_000);

afterAll(async () => {
  await eventsClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }));
  await truncateAll();
  eventsClient.destroy();
  await orm.close();
}, 30_000);

async function outboxRows(): Promise<OutboxRow[]> {
  return orm.em
    .getConnection()
    .execute<OutboxRow[]>('SELECT id, event_type, aggregate_id, published_at FROM outbox_messages ORDER BY occurred_at');
}

/** Recebe e APAGA mensagens reais da fila (nunca so GetQueueAttributes) ate juntar `expectedCount` ou estourar o timeout. */
async function drainEventsQueue(expectedCount: number, timeoutMs: number): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const deadline = Date.now() + timeoutMs;

  while (received.length < expectedCount && Date.now() < deadline) {
    const { Messages } = await eventsClient.send(
      new ReceiveMessageCommand({ QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
    );
    if (!Messages || Messages.length === 0) {
      continue;
    }
    for (const message of Messages) {
      if (message.Body === undefined || message.ReceiptHandle === undefined) {
        continue;
      }
      received.push(JSON.parse(message.Body) as ReceivedEvent);
      await eventsClient.send(new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }

  return received;
}

describe('Reinicio real do servico — processo morto com SIGKILL, novo processo retoma (Bloco 13b, secao 11)', () => {
  test(
    '3 eventos commitados antes da queda + 4 gerados apos o reinicio = 7 publicados, sem duplicacao, saldo == ledger reconstruido',
    async () => {
      let instance1: AppInstance | undefined;
      let instance2: AppInstance | undefined;

      try {
        // ---- ANTES DA QUEDA: processo #1, so HTTP, nenhum worker em background ligado ----
        instance1 = await spawnAppInstance({
          port: INSTANCE_1_PORT,
          consumerEnabled: false,
          outboxPublisherEnabled: false,
          pendingReferenceWorkerEnabled: false,
        });

        const playerId = randomUUID();
        const openResponse = await fetch(`${instance1.baseUrl}/wallets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
        });
        const openBody = (await openResponse.json()) as OpenWalletBody;
        const walletId = openBody.id;

        const betExternalId = `bet-${randomUUID()}`;
        const refundExternalId = `refund-${randomUUID()}`;

        const refundResponse = await fetch(`${instance1.baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          body: JSON.stringify({
            providerId: 'provider-a',
            externalTransactionId: refundExternalId,
            playerId,
            walletId,
            roundId: 'round-1',
            gameId: 'fortune-chimp',
            kind: 'REFUND',
            money: { amount: '30.00', currency: 'BRL' },
            referenceExternalTransactionId: betExternalId,
          }),
        });
        const refundBody = (await refundResponse.json()) as SubmitBody;
        expect(refundResponse.status).toBe(202);
        expect(refundBody.status).toBe('PENDING_REFERENCE');

        // Exatamente 3 linhas pendentes: WagerTransactionProcessed +
        // WalletBalanceChanged (OPENING com saldo positivo) e
        // WagerTransactionPendingReference (REFUND ainda sem BET).
        const preCrashRows = await outboxRows();
        expect(preCrashRows).toHaveLength(3);
        expect(preCrashRows.every((row) => row.published_at === null)).toBe(true);
        expect(preCrashRows.map((row) => row.event_type).sort()).toEqual(
          ['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged'].sort(),
        );
        const preCrashIds = new Set(preCrashRows.map((row) => row.id));

        // ---- A QUEDA: SIGKILL, nao SIGTERM — nenhum shutdown hook roda, simula queda abrupta real. ----
        await instance1.kill('SIGKILL');
        instance1 = undefined;

        // Nada mudou so por causa da morte do processo — as 3 linhas continuam ali, intactas.
        const afterCrashRows = await outboxRows();
        expect(afterCrashRows).toHaveLength(3);
        expect(afterCrashRows.every((row) => row.published_at === null)).toBe(true);

        // ---- DEPOIS DO REINICIO: processo #2, novo, so com os workers realmente necessarios. ----
        instance2 = await spawnAppInstance({
          port: INSTANCE_2_PORT,
          consumerEnabled: false,
          outboxPublisherEnabled: true,
          pendingReferenceWorkerEnabled: true,
        });

        const betResponse = await fetch(`${instance2.baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          body: JSON.stringify({
            providerId: 'provider-a',
            externalTransactionId: betExternalId,
            playerId,
            walletId,
            roundId: 'round-1',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '30.00', currency: 'BRL' },
          }),
        });
        const betBody = (await betResponse.json()) as SubmitBody;
        expect(betResponse.status).toBe(201);
        expect(betBody.status).toBe('PROCESSED');

        // A resolucao do REFUND depende do worker de PENDING_REFERENCE (tick a
        // cada 3s, ver retry-worker.config.ts) — polling com timeout, nunca sleep fixo.
        await waitFor(
          async () => {
            const rows = await orm.em
              .getConnection()
              .execute<{ status: string }[]>('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [
                refundExternalId,
              ]);
            return rows[0]?.status === 'PROCESSED';
          },
          { timeoutMs: 15_000, description: 'REFUND resolvido pelo worker de PENDING_REFERENCE do processo novo' },
        );

        // 7 linhas no total, todas publicadas pelo publisher do processo novo.
        await waitFor(
          async () => {
            const rows = await outboxRows();
            return rows.length === 7 && rows.every((row) => row.published_at !== null);
          },
          { timeoutMs: 15_000, description: '7 linhas de outbox, todas publicadas' },
        );

        const finalRows = await outboxRows();
        expect(finalRows).toHaveLength(7);
        expect(finalRows.every((row) => row.published_at !== null)).toBe(true);

        const newRows = finalRows.filter((row) => !preCrashIds.has(row.id));
        expect(newRows).toHaveLength(4);
        expect(newRows.map((row) => row.event_type).sort()).toEqual(
          ['WagerTransactionProcessed', 'WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged'].sort(),
        );

        // ---- Fila real de eventos: recebe e INSPECIONA cada mensagem — nunca so uma contagem aproximada. ----
        const receivedEvents = await drainEventsQueue(7, 20_000);
        expect(receivedEvents).toHaveLength(7);

        const receivedIds = receivedEvents.map((event) => event.eventId);
        expect(new Set(receivedIds).size).toBe(7); // nenhum id duplicado na fila

        const finalIds = new Set(finalRows.map((row) => row.id));
        for (const id of receivedIds) {
          expect(finalIds.has(id)).toBe(true);
        }
        for (const id of preCrashIds) {
          expect(receivedIds).toContain(id); // os 3 IDs anteriores a queda foram de fato publicados
        }

        const receivedTypeCounts = receivedEvents.reduce<Record<string, number>>((acc, event) => {
          acc[event.eventType] = (acc[event.eventType] ?? 0) + 1;
          return acc;
        }, {});
        expect(receivedTypeCounts).toEqual({
          WagerTransactionProcessed: 3, // OPENING, BET, REFUND
          WalletBalanceChanged: 3, // OPENING, BET, REFUND
          WagerTransactionPendingReference: 1, // REFUND, antes da queda
        });

        for (const event of receivedEvents) {
          expect(event.data.walletId).toBe(walletId);
        }

        // ---- Invariante financeira final ----
        const refundRow = (
          await orm.em
            .getConnection()
            .execute<{ id: string }[]>('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [
              refundExternalId,
            ])
        )[0];

        const refundCreditCount = await orm.em.getConnection().execute<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = ? AND direction = 'CREDIT'`,
          [refundRow.id],
        );
        expect(refundCreditCount[0].count).toBe(1);

        const walletRow = (
          await orm.em
            .getConnection()
            .execute<{ balance_amount: string }[]>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId])
        )[0];
        // OPENING credita 100, BET debita 30, REFUND credita 30 de volta.
        expect(walletRow.balance_amount).toBe('100.00');

        const ledgerRows = await orm.em
          .getConnection()
          .execute<{ direction: string; amount: string }[]>(
            'SELECT direction, amount FROM wallet_ledger_entries WHERE wallet_id = ?',
            [walletId],
          );
        const reconstructedBalance = ledgerRows.reduce((total, row) => {
          const signed = row.direction === 'CREDIT' ? Number(row.amount) : -Number(row.amount);
          return total + signed;
        }, 0);
        expect(reconstructedBalance.toFixed(2)).toBe(walletRow.balance_amount);
      } finally {
        if (instance1) await instance1.kill('SIGKILL');
        if (instance2) await instance2.kill('SIGTERM');
      }
    },
    90_000,
  );
});
