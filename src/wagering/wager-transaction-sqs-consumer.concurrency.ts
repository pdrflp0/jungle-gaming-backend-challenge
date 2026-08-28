import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { OpenWalletUseCase } from '../wallets/open-wallet.use-case';
import { createSqsClient, resolveQueueUrl, WAGER_TRANSACTIONS_QUEUE_NAME } from './sqs-client';
import { buildWagerTransactionMessageBody, sendTestMessage, waitFor } from './sqs-test-helpers';
import { WagerTransactionSqsConsumer } from './wager-transaction-sqs-consumer';

/**
 * Concorrencia real: DUAS instancias do consumidor SQS (Bloco 9b.2) contra a
 * mesma fila real do LocalStack, cada uma com seu proprio EntityManager
 * (`orm.em.fork()`) e seu proprio SQSClient — exatamente como duas
 * instancias da aplicacao rodando em processos/maquinas diferentes fariam.
 * Nenhum lock de aplicacao: a garantia de exclusao mutua e o SQS entregando
 * cada mensagem a um so consumidor por vez (visibility timeout) MAIS a PK
 * composta do Inbox no Postgres para o caso de redelivery/corrida (ja
 * provado sem SQS no Bloco 9b.1).
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:concurrency`.
 */

let orm: MikroORM;
let sendClient: SQSClient;
let queueUrl: string;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED = 'true';
  process.env.WAGER_TRANSACTIONS_SQS_WAIT_TIME_SECONDS = '2';
  sendClient = createSqsClient();
  queueUrl = await resolveQueueUrl(sendClient, WAGER_TRANSACTIONS_QUEUE_NAME);
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
});

afterEach(async () => {
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
});

afterAll(async () => {
  delete process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED;
  delete process.env.WAGER_TRANSACTIONS_SQS_WAIT_TIME_SECONDS;
  sendClient.destroy();
  await orm.close();
});

async function createWallet(initialAmount: string): Promise<{ walletId: string; playerId: string }> {
  const em = orm.em.fork();
  const playerId = randomUUID();
  const useCase = new OpenWalletUseCase(em);
  const result = await useCase.execute(
    { playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } },
    randomUUID(),
  );
  return { walletId: result.id, playerId };
}

function startConsumerInstance(): Promise<WagerTransactionSqsConsumer> {
  const consumer = new WagerTransactionSqsConsumer(orm.em.fork());
  return consumer.onModuleInit().then(() => consumer);
}

async function stopConsumerInstance(consumer: WagerTransactionSqsConsumer): Promise<void> {
  await consumer.onApplicationShutdown();
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

describe('WagerTransactionSqsConsumer — duas instancias reais (Bloco 9b.2)', () => {
  test('5 mensagens distintas processadas por duas instancias: cada wallet debitada exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet('100.00')));
    const externalIds = wallets.map(() => randomUUID());

    await Promise.all(
      wallets.map((wallet, index) =>
        sendTestMessage(
          sendClient,
          queueUrl,
          buildWagerTransactionMessageBody(wallet.walletId, wallet.playerId, {
            dataOverrides: { externalTransactionId: externalIds[index] },
          }),
          { messageGroupId: wallet.walletId, messageDeduplicationId: randomUUID() },
        ),
      ),
    );

    const consumerA = await startConsumerInstance();
    const consumerB = await startConsumerInstance();
    try {
      await Promise.all(
        wallets.map((_, index) =>
          waitFor(async () => (await wagerTransactionStatus('provider-a', externalIds[index])) === 'PROCESSED', {
            timeoutMs: 15_000,
            description: `mensagem ${index} processada`,
          }),
        ),
      );

      for (const wallet of wallets) {
        expect(await walletBalance(wallet.walletId)).toBe('75.00');
        expect(await countDebitLedgerEntries(wallet.walletId)).toBe(1);
      }
    } finally {
      await Promise.all([stopConsumerInstance(consumerA), stopConsumerInstance(consumerB)]);
    }
  }, 30_000);

  test('mesma messageId entregue duas vezes (dedup de transporte diferente): exatamente um efeito financeiro, repetido 3x', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { walletId, playerId } = await createWallet('100.00');
      const messageId = randomUUID();
      const externalTransactionId = randomUUID();
      const body = buildWagerTransactionMessageBody(walletId, playerId, { messageId, dataOverrides: { externalTransactionId } });

      // Duas entregas da MESMA mensagem de negocio, quase simultaneas — o
      // cenario real de "visibility timeout expirou enquanto a primeira
      // ainda processava e o SQS reentregou para a outra instancia".
      await Promise.all([
        sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() }),
        sendTestMessage(sendClient, queueUrl, body, { messageGroupId: walletId, messageDeduplicationId: randomUUID() }),
      ]);

      const consumerA = await startConsumerInstance();
      const consumerB = await startConsumerInstance();
      try {
        await waitFor(async () => (await wagerTransactionStatus('provider-a', externalTransactionId)) === 'PROCESSED', {
          timeoutMs: 15_000,
        });

        // da tempo da SEGUNDA entrega (que so pode resultar em 'duplicate')
        // tambem ser recebida e apagada por uma das duas instancias.
        await new Promise((resolve) => setTimeout(resolve, 1500));

        expect(await walletBalance(walletId)).toBe('75.00'); // debitado exatamente uma vez
        expect(await countDebitLedgerEntries(walletId)).toBe(1);
      } finally {
        await Promise.all([stopConsumerInstance(consumerA), stopConsumerInstance(consumerB)]);
      }
    }
  }, 60_000);
});
