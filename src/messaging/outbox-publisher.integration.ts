import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import config from '../../mikro-orm.config';
import { createSqsClient, resolveQueueUrl } from '../wagering/sqs-client';
import { OpenWalletUseCase } from '../wallets/open-wallet.use-case';
import { publishDueOutboxMessage, WAGER_TRANSACTION_EVENTS_QUEUE_NAME } from './outbox-publisher';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { selectDueOutboxMessageForUpdate } from './outbox.sql';

/**
 * Integracao real do publisher da Outbox (Bloco 9c): LocalStack real +
 * PostgreSQL real. `publishDueOutboxMessage` (Bloco 9c) e a mesma funcao
 * nucleo usada pelo `OutboxPublisherWorker` real — nenhum loop/`@Interval`
 * entra aqui, exatamente como o nucleo do consumidor (Bloco 9b.1) foi
 * testado sem o loop de `ReceiveMessage` do 9b.2.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:integration`.
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
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }));
});

afterAll(async () => {
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

interface RawOutboxRow {
  id: string;
  event_type: string;
  payload: { eventId: string; eventType: string; correlationId: string; data: Record<string, unknown> };
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

async function outboxRowById(id: string): Promise<RawOutboxRow> {
  const rows = await orm.em
    .getConnection()
    .execute<RawOutboxRow[]>('SELECT * FROM outbox_messages WHERE id = ?', [id]);
  return rows[0];
}

async function outboxRowsForWallet(walletId: string): Promise<RawOutboxRow[]> {
  const rows = await orm.em
    .getConnection()
    .execute<RawOutboxRow[]>(
      "SELECT * FROM outbox_messages WHERE payload -> 'data' ->> 'walletId' = ? ORDER BY event_type",
      [walletId],
    );
  return rows;
}

interface InsertOutboxRowOptions {
  id?: string;
  walletId?: string;
  eventType?: string;
  extraData?: Record<string, unknown>;
  omitWalletId?: boolean;
  attempts?: number;
  nextAttemptAt?: Date;
}

/** Insercao sintetica direta — para testes que precisam de controle cirurgico sobre o payload, sem passar pelo fluxo financeiro inteiro. */
async function insertOutboxRow(options: InsertOutboxRowOptions = {}): Promise<{ id: string; walletId: string }> {
  const id = options.id ?? randomUUID();
  const walletId = options.walletId ?? randomUUID();
  const data: Record<string, unknown> = { transactionId: randomUUID(), ...options.extraData };
  if (!options.omitWalletId) {
    data.walletId = walletId;
  }
  const payload = {
    eventId: id,
    eventType: options.eventType ?? 'WagerTransactionProcessed',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    version: 1,
    data,
  };

  await orm.em.getConnection().execute(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?::jsonb, now(), ?, ?)`,
    [
      id,
      payload.aggregateId,
      payload.eventType,
      JSON.stringify(payload),
      options.attempts ?? 0,
      options.nextAttemptAt ?? new Date(),
    ],
  );

  return { id, walletId };
}

async function totalEventsQueueMessageCount(): Promise<number> {
  const { Attributes } = await sendClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: eventsQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? '0') + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
}

async function waitFor(conditionFn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await conditionFn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('waitFor: condicao nao satisfeita a tempo');
}

describe('publishDueOutboxMessage — publicacao de evento pendente real (Bloco 9c)', () => {
  test('OPENING com saldo positivo: os 2 eventos ficam publicados e chegam na fila real', async () => {
    const { walletId } = await createWallet('100.00');

    // drena tudo que estiver due (os 2 eventos da OPENING)
    let iterations = 0;
    while ((await publishDueOutboxMessage(orm.em.fork(), sendClient, eventsQueueUrl)) && iterations < 10) {
      iterations += 1;
    }

    const rows = await outboxRowsForWallet(walletId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.published_at).not.toBeNull();
      expect(row.next_attempt_at).toBeNull();
    }

    await waitFor(async () => (await totalEventsQueueMessageCount()) === 2);

    const { Messages } = await sendClient.send(
      new ReceiveMessageCommand({ QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
    );
    expect(Messages).toHaveLength(2);
    for (const message of Messages ?? []) {
      const body = JSON.parse(message.Body as string) as { data: { walletId: string } };
      expect(body.data.walletId).toBe(walletId);
    }
  }, 15_000);

  test('sem nenhuma linha due: retorna false, nao publica nada', async () => {
    const processed = await publishDueOutboxMessage(orm.em.fork(), sendClient, eventsQueueUrl);
    expect(processed).toBe(false);
  });
});

describe('publishDueOutboxMessage — falha antes do envio (Bloco 9c)', () => {
  test('payload sem walletId: nao publica, nao marca published, agenda retry, nada chega na fila', async () => {
    const { id } = await insertOutboxRow({ omitWalletId: true });

    const processed = await publishDueOutboxMessage(orm.em.fork(), sendClient, eventsQueueUrl);
    expect(processed).toBe(true);

    const row = await outboxRowById(id);
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();

    expect(await totalEventsQueueMessageCount()).toBe(0);
  });
});

describe('publishDueOutboxMessage — retry com attempts e next_attempt_at (Bloco 9c)', () => {
  test('SendMessage falha (fila inexistente): attempts incrementa, next_attempt_at avanca pelo backoff, published_at continua nulo', async () => {
    const { id } = await insertOutboxRow();
    const bogusQueueUrl = `${eventsQueueUrl}-does-not-exist`;

    const before = new Date();
    const processed = await publishDueOutboxMessage(orm.em.fork(), sendClient, bogusQueueUrl);
    expect(processed).toBe(true);

    const row = await outboxRowById(id);
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
    // backoff da primeira tentativa: 5s (computeOutboxNextAttemptDelaySeconds(1))
    // o driver devolve timestamptz cru como string, nao Date (mesma licao do Bloco 7b)
    expect(new Date(row.next_attempt_at as unknown as string).getTime()).toBeGreaterThanOrEqual(before.getTime() + 4000);
  });
});

describe('publishDueOutboxMessage — commit local falha depois do SendMessage ter sucesso (Bloco 9c)', () => {
  test('linha continua pendente mesmo com a mensagem ja entregue de verdade; republicar depois e seguro (duplicata aceita)', async () => {
    const { id, walletId } = await insertOutboxRow();

    class ForcedRollback extends Error {}

    const em = orm.em.fork();
    await expect(
      em.transactional(async (trxEm) => {
        const dueRow = await selectDueOutboxMessageForUpdate(trxEm);
        expect(dueRow?.id).toBe(id);

        // SendMessage de verdade — o efeito externo ACONTECE aqui.
        await sendClient.send(
          new SendMessageCommand({
            QueueUrl: eventsQueueUrl,
            MessageBody: JSON.stringify(dueRow?.payload),
            MessageGroupId: walletId,
            MessageDeduplicationId: id,
          }),
        );

        // simula o processo caindo ANTES do commit local — a linha nunca e
        // marcada como publicada, mesmo a mensagem ja tendo saido.
        throw new ForcedRollback('crash antes do commit');
      }),
    ).rejects.toThrow(ForcedRollback);

    const rowAfterCrash = await outboxRowById(id);
    expect(rowAfterCrash.published_at).toBeNull(); // nossa contabilidade nao sabe do envio

    await waitFor(async () => (await totalEventsQueueMessageCount()) >= 1); // mas a mensagem ja esta la

    // o publisher de verdade reivindica a MESMA linha (ainda due) e publica de novo
    const processed = await publishDueOutboxMessage(orm.em.fork(), sendClient, eventsQueueUrl);
    expect(processed).toBe(true);

    const rowFinal = await outboxRowById(id);
    expect(rowFinal.published_at).not.toBeNull(); // agora sim, marcado

    // a duplicata de ENTREGA (mesmo MessageDeduplicationId, dentro da janela
    // do SQS) e exatamente o que a secao 11 do CHALLENGE.md aceita como
    // seguro — quem garante o efeito financeiro exatamente-uma-vez do lado
    // de quem consome e a Inbox (ja provada nos Blocos 9b.1/9b.2), nao o
    // publisher.
  }, 15_000);
});

describe('publishDueOutboxMessage — replay com MessageDeduplicationId estavel (Bloco 9c)', () => {
  test('duas chamadas reais de SendMessage com o mesmo MessageDeduplicationId: o SQS deduplica no transporte', async () => {
    const dedupId = randomUUID();
    const groupId = randomUUID();

    await sendClient.send(
      new SendMessageCommand({
        QueueUrl: eventsQueueUrl,
        MessageBody: JSON.stringify({ attempt: 1 }),
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId,
      }),
    );
    await sendClient.send(
      new SendMessageCommand({
        QueueUrl: eventsQueueUrl,
        MessageBody: JSON.stringify({ attempt: 2 }),
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId, // mesmo id — mesma janela de dedup do SQS
      }),
    );

    await waitFor(async () => (await totalEventsQueueMessageCount()) >= 1);
    // da um instante para uma eventual segunda mensagem (nao deveria existir)
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await totalEventsQueueMessageCount()).toBe(1);
  });
});

describe('publishDueOutboxMessage — crash/reinicio sem perda (Bloco 9c)', () => {
  test('linha criada antes de qualquer publisher rodar continua intacta e e publicada por uma instancia nova', async () => {
    const { id } = await insertOutboxRow();

    // simula "reinicio": nenhum publisher tocou nesta linha ainda, o estado
    // inteiro sobrevive so porque esta no Postgres.
    const rowBefore = await outboxRowById(id);
    expect(rowBefore.published_at).toBeNull();

    const freshEm = orm.em.fork();
    const freshClient = createSqsClient();
    try {
      const processed = await publishDueOutboxMessage(freshEm, freshClient, eventsQueueUrl);
      expect(processed).toBe(true);
    } finally {
      freshClient.destroy();
    }

    const rowAfter = await outboxRowById(id);
    expect(rowAfter.published_at).not.toBeNull();
  });
});

describe('OutboxPublisherWorker — shutdown gracioso (Bloco 9c)', () => {
  test('publica a linha em andamento antes de parar; nao inicia novo ciclo depois do shutdown', async () => {
    process.env.OUTBOX_PUBLISHER_ENABLED = 'true';
    try {
      const { id } = await insertOutboxRow();

      const worker = new OutboxPublisherWorker(orm.em.fork());
      await worker.onModuleInit();
      await waitFor(async () => (await outboxRowById(id)).published_at !== null, 5000);
      await worker.onApplicationShutdown();

      // depois do shutdown, nenhum novo ciclo roda: inserir uma segunda
      // linha e confirmar que ela continua pendente (ninguem mais esta
      // fazendo polling).
      const { id: secondId } = await insertOutboxRow();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const secondRow = await outboxRowById(secondId);
      expect(secondRow.published_at).toBeNull();
    } finally {
      delete process.env.OUTBOX_PUBLISHER_ENABLED;
    }
  }, 15_000);

  test('desligado por padrao: onModuleInit nao inicia nenhum ciclo sem a variavel de ambiente', async () => {
    delete process.env.OUTBOX_PUBLISHER_ENABLED;
    const { id } = await insertOutboxRow();

    const worker = new OutboxPublisherWorker(orm.em.fork());
    await worker.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const row = await outboxRowById(id);
    expect(row.published_at).toBeNull(); // nada rodou

    await worker.onApplicationShutdown(); // deve ser um no-op seguro mesmo sem nunca ter iniciado
  });
});
