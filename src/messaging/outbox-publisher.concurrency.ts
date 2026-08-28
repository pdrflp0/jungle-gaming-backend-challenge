import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { createSqsClient, resolveQueueUrl } from '../wagering/sqs-client';
import { publishDueOutboxMessage, WAGER_TRANSACTION_EVENTS_QUEUE_NAME } from './outbox-publisher';

/**
 * Concorrencia real: DUAS instancias do publisher da Outbox (Bloco 9c)
 * disputando VARIAS linhas due ao mesmo tempo, cada uma com seu proprio
 * EntityManager (`orm.em.fork()`) e seu proprio SQSClient — exatamente como
 * duas instancias da aplicacao rodando em processos diferentes fariam.
 * Garantia de exclusao mutua e o `FOR UPDATE SKIP LOCKED` do Postgres,
 * nunca um lock de aplicacao.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:concurrency`.
 */

let orm: MikroORM;
let sendClient: SQSClient;
let eventsQueueUrl: string;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  sendClient = createSqsClient();
  eventsQueueUrl = await resolveQueueUrl(sendClient, WAGER_TRANSACTION_EVENTS_QUEUE_NAME);
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }));
});

afterEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE outbox_messages');
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }));
});

afterAll(async () => {
  sendClient.destroy();
  await orm.close();
});

async function insertOutboxRow(): Promise<{ id: string; walletId: string }> {
  const id = randomUUID();
  const walletId = randomUUID();
  const payload = {
    eventId: id,
    eventType: 'WagerTransactionProcessed',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    version: 1,
    data: { transactionId: randomUUID(), walletId },
  };

  await orm.em.getConnection().execute(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?::jsonb, now(), 0, now())`,
    [id, payload.aggregateId, payload.eventType, JSON.stringify(payload)],
  );

  return { id, walletId };
}

async function countPublished(): Promise<number> {
  const rows = await orm.em
    .getConnection()
    .execute<{ count: number }[]>('SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NOT NULL');
  return rows[0].count;
}

async function totalEventsQueueMessageCount(): Promise<number> {
  const { Attributes } = await sendClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: eventsQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? '0') + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}

async function waitFor(conditionFn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await conditionFn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('waitFor: condicao nao satisfeita a tempo');
}

describe('publishDueOutboxMessage — dois publishers reais disputando varias linhas (Bloco 9c)', () => {
  test('10 linhas pendentes: cada uma publicada exatamente uma vez, nenhuma perdida, nenhuma duplicada na nossa contabilidade', async () => {
    const rows = await Promise.all(Array.from({ length: 10 }, () => insertOutboxRow()));

    const clientA = createSqsClient();
    const clientB = createSqsClient();
    try {
      // Cada "instancia" drena em loop ate nao achar mais nada due — as duas
      // rodando ao mesmo tempo, cada uma com seu proprio EntityManager e
      // cliente SQS.
      async function drain(client: SQSClient): Promise<number> {
        let count = 0;
        while (await publishDueOutboxMessage(orm.em.fork(), client, eventsQueueUrl)) {
          count += 1;
        }
        return count;
      }

      const [countA, countB] = await Promise.all([drain(clientA), drain(clientB)]);

      expect(countA + countB).toBe(10);
      expect(await countPublished()).toBe(10);
      await waitFor(async () => (await totalEventsQueueMessageCount()) === 10);
    } finally {
      clientA.destroy();
      clientB.destroy();
    }
  }, 30_000);
});
