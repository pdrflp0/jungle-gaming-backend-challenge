import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { selectDlqDepth } from '../observability/dlq-depth';
import { AppInstance, requireFreePorts, spawnAppInstance } from './spawn-app-instance';
import { createSqsClient, resolveQueueUrl, WAGER_TRANSACTIONS_QUEUE_NAME } from './sqs-client';
import { buildWagerTransactionMessageBody, sendTestMessage, waitFor } from './sqs-test-helpers';

/**
 * CHALLENGE.md secao 13: "execucao com pelo menos 3 processos/instancias
 * reais e independentes". wager-transaction-sqs-consumer.concurrency.ts e
 * outbox-publisher.concurrency.ts (Blocos 9b.2/9c) ja provam ausencia de
 * corrida com DOIS OBJETOS concorrentes dentro do MESMO processo Bun
 * (`orm.em.fork()`/`SQSClient` proprios cada) — nunca cruzam um limite real
 * de processo do SO. Este arquivo fecha essa lacuna especifica: tres
 * processos `bun run src/main.ts` REAIS, cada um com sua propria memoria e
 * event loop, contra o mesmo Postgres/SQS reais.
 *
 * Dois subcenarios, cada um com seu proprio `describe`/`beforeAll`/`afterAll`
 * (preparacao, criterios e diagnostico independentes):
 *  1. disputa de mensagens reais pela fila `wager-transactions.fifo` entre 3
 *     processos;
 *  2. duas BET de 80 concorrentes sobre saldo 100 (cenario obrigatorio da
 *     secao 8), cada uma submetida por um PROCESSO diferente via HTTP.
 *
 * Deliberadamente lento (3 boots completos da aplicacao Nest por
 * subcenario) — por isso mora em `test:concurrency:processes`, nunca em
 * `test:concurrency` nem em `bun test`. Sem sufixo .spec./.test. de proposito.
 */

const PORTS = [3301, 3302, 3303];

async function truncateAll(orm: MikroORM): Promise<void> {
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
}

describe('3 processos reais — disputa de mensagens na fila real (Bloco 13a.1)', () => {
  let orm: MikroORM;
  let sendClient: SQSClient;
  let queueUrl: string;
  let instances: AppInstance[] = [];

  beforeAll(async () => {
    await requireFreePorts(PORTS);
    orm = await MikroORM.init(config);
    await truncateAll(orm);
    sendClient = createSqsClient();
    queueUrl = await resolveQueueUrl(sendClient, WAGER_TRANSACTIONS_QUEUE_NAME);
    await sendClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    instances = await Promise.all(
      PORTS.map((port) =>
        spawnAppInstance({
          port,
          consumerEnabled: true,
          outboxPublisherEnabled: false,
          pendingReferenceWorkerEnabled: false,
          extraEnv: { WAGER_TRANSACTIONS_SQS_WAIT_TIME_SECONDS: '2' },
        }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    try {
      await Promise.all(instances.map((instance) => instance.kill('SIGTERM')));
    } finally {
      await sendClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
      await truncateAll(orm);
      sendClient.destroy();
      await orm.close();
    }
  }, 30_000);

  async function createWallet(initialAmount: string): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const response = await fetch(`${instances[0].baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } }),
    });
    const body = (await response.json()) as { id: string };
    return { walletId: body.id, playerId };
  }

  async function walletBalance(walletId: string): Promise<string> {
    const rows = await orm.em
      .getConnection()
      .execute<{ balance_amount: string }[]>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
    return rows[0].balance_amount;
  }

  async function countDebitLedgerEntries(walletId: string): Promise<number> {
    const rows = await orm.em
      .getConnection()
      .execute<{ count: number }[]>(
        "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [walletId],
      );
    return rows[0].count;
  }

  async function wagerTransactionStatus(providerId: string, externalTransactionId: string): Promise<string | undefined> {
    const rows = await orm.em
      .getConnection()
      .execute<{ status: string }[]>(
        'SELECT status FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
        [providerId, externalTransactionId],
      );
    return rows[0]?.status;
  }

  test(
    '7 wallets distintas (6 mensagens unicas + 1 entregue duas vezes): cada uma debitada exatamente uma vez, fila drenada, nada na DLQ',
    async () => {
      const uniqueWallets = await Promise.all(Array.from({ length: 6 }, () => createWallet('100.00')));
      const uniqueExternalIds = uniqueWallets.map(() => randomUUID());

      const duplicateWallet = await createWallet('100.00');
      const duplicateExternalId = randomUUID();
      const duplicateMessageId = randomUUID();
      const duplicateBody = buildWagerTransactionMessageBody(duplicateWallet.walletId, duplicateWallet.playerId, {
        messageId: duplicateMessageId,
        dataOverrides: { externalTransactionId: duplicateExternalId },
      });

      await Promise.all([
        ...uniqueWallets.map((wallet, index) =>
          sendTestMessage(
            sendClient,
            queueUrl,
            buildWagerTransactionMessageBody(wallet.walletId, wallet.playerId, {
              dataOverrides: { externalTransactionId: uniqueExternalIds[index] },
            }),
            { messageGroupId: wallet.walletId, messageDeduplicationId: randomUUID() },
          ),
        ),
        // mesma messageId de negocio entregue duas vezes — o cenario real de
        // "visibility timeout expirou enquanto um dos 3 processos ainda
        // processava e o SQS reentregou para outro processo".
        sendTestMessage(sendClient, queueUrl, duplicateBody, {
          messageGroupId: duplicateWallet.walletId,
          messageDeduplicationId: randomUUID(),
        }),
        sendTestMessage(sendClient, queueUrl, duplicateBody, {
          messageGroupId: duplicateWallet.walletId,
          messageDeduplicationId: randomUUID(),
        }),
      ]);

      const allWallets = [...uniqueWallets, duplicateWallet];
      const allExternalIds = [...uniqueExternalIds, duplicateExternalId];

      await Promise.all(
        allWallets.map((_, index) =>
          waitFor(async () => (await wagerTransactionStatus('provider-a', allExternalIds[index])) === 'PROCESSED', {
            timeoutMs: 20_000,
            description: `mensagem ${index} processada por algum dos 3 processos`,
          }),
        ),
      );

      for (const wallet of allWallets) {
        expect(await walletBalance(wallet.walletId)).toBe('75.00');
        expect(await countDebitLedgerEntries(wallet.walletId)).toBe(1);
      }

      // fila de entrada drenada (nenhuma mensagem visivel nem em voo) e nada
      // foi parar na DLQ — os 3 processos deram conta de tudo sem perder nem
      // duplicar efeito financeiro nenhum.
      await waitFor(
        async () => {
          const { Attributes } = await sendClient.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
            }),
          );
          const visible = Number(Attributes?.ApproximateNumberOfMessages ?? '0');
          const inFlight = Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
          return visible === 0 && inFlight === 0;
        },
        { timeoutMs: 10_000, description: 'fila wager-transactions.fifo drenada' },
      );

      const dlqDepth = await selectDlqDepth(sendClient);
      expect(dlqDepth.visible).toBe(0);
      expect(dlqDepth.inFlight).toBe(0);
    },
    45_000,
  );
});

describe('3 processos reais — duas BET concorrentes por HTTP (Bloco 13a.2, secao 8)', () => {
  let orm: MikroORM;
  let instances: AppInstance[] = [];

  beforeAll(async () => {
    await requireFreePorts(PORTS);
    orm = await MikroORM.init(config);
    await truncateAll(orm);

    instances = await Promise.all(
      PORTS.map((port) =>
        spawnAppInstance({
          port,
          consumerEnabled: false,
          outboxPublisherEnabled: false,
          pendingReferenceWorkerEnabled: false,
        }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    try {
      await Promise.all(instances.map((instance) => instance.kill('SIGTERM')));
    } finally {
      await truncateAll(orm);
      await orm.close();
    }
  }, 30_000);

  interface OpenWalletBody {
    id: string;
  }
  interface SubmitBody {
    transactionId: string;
    status: string;
    balance?: { amount: string; currency: string };
  }

  async function createWallet(baseUrl: string, initialAmount: string): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } }),
    });
    const body = (await response.json()) as OpenWalletBody;
    return { walletId: body.id, playerId };
  }

  function submitBet(
    baseUrl: string,
    walletId: string,
    playerId: string,
    externalTransactionId: string,
    amount: string,
  ): Promise<Response> {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      }),
    });
  }

  test(
    'W1 disputada por 2 processos (uma PROCESSED, uma REJECTED, saldo 20) enquanto o 3o processo atende W2 ao mesmo tempo',
    async () => {
      const [instanceA, instanceB, instanceC] = instances;

      const w1 = await createWallet(instanceA.baseUrl, '100.00');
      const w2 = await createWallet(instanceC.baseUrl, '100.00');

      const [responseA, responseB, responseC] = await Promise.all([
        submitBet(instanceA.baseUrl, w1.walletId, w1.playerId, 'ext-w1-a', '80.00'),
        submitBet(instanceB.baseUrl, w1.walletId, w1.playerId, 'ext-w1-b', '80.00'),
        submitBet(instanceC.baseUrl, w2.walletId, w2.playerId, 'ext-w2-a', '30.00'),
      ]);

      const [bodyA, bodyB, bodyC] = await Promise.all([
        responseA.json() as Promise<SubmitBody>,
        responseB.json() as Promise<SubmitBody>,
        responseC.json() as Promise<SubmitBody>,
      ]);

      const w1Statuses = [bodyA.status, bodyB.status].sort();
      expect(w1Statuses).toEqual(['PROCESSED', 'REJECTED']);
      const w1HttpStatuses = [responseA.status, responseB.status].sort();
      expect(w1HttpStatuses).toEqual([201, 422]);

      expect(bodyC.status).toBe('PROCESSED');
      expect(responseC.status).toBe(201);

      const conn = orm.em.getConnection();

      const w1Row = (await conn.execute('SELECT balance_amount FROM wallets WHERE id = ?', [w1.walletId])) as {
        balance_amount: string;
      }[];
      expect(w1Row[0].balance_amount).toBe('20.00');

      const w1Debits = (await conn.execute(
        "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [w1.walletId],
      )) as { count: number }[];
      expect(w1Debits[0].count).toBe(1);

      const w2Row = (await conn.execute('SELECT balance_amount FROM wallets WHERE id = ?', [w2.walletId])) as {
        balance_amount: string;
      }[];
      expect(w2Row[0].balance_amount).toBe('70.00');

      const w2Debits = (await conn.execute(
        "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [w2.walletId],
      )) as { count: number }[];
      expect(w2Debits[0].count).toBe(1);
    },
    30_000,
  );
});
