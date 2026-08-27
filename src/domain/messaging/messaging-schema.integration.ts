import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../../mikro-orm.config';
import { InboxMessageEntity } from '../../infra/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../infra/database/entities/outbox-message.entity';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';
import { WagerTransactionProcessed } from './wagering-events';

/**
 * Integracao real do schema do Bloco 9a.1 contra PostgreSQL: prova que as
 * entidades mapeiam corretamente as classes de dominio (PK composta da
 * Inbox, jsonb da Outbox preservando o envelope inteiro). Nao existe
 * insertOutboxMessage/insertInboxMessage ainda (nasce so com chamador real
 * no 9a.2/9b) — este teste persiste via MikroORM diretamente.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:integration`.
 */

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE outbox_messages, inbox_messages');
});

afterAll(async () => {
  await orm.close();
});

function buildProcessedEvent() {
  return WagerTransactionProcessed.create({
    eventId: '0192f298-0000-7000-8000-000000000001',
    aggregateId: '0192f298-0000-7000-8000-000000000002',
    correlationId: '0192f298-0000-7000-8000-000000000003',
    causationId: '0192f298-0000-7000-8000-000000000004',
    occurredAt: new Date('2026-08-29T12:00:00.000Z'),
    data: {
      transactionId: '0192f298-0000-7000-8000-000000000002',
      walletId: '0192f298-0000-7000-8000-000000000005',
      playerId: '0192f298-0000-7000-8000-000000000006',
      providerId: 'provider-a',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
      processedAt: '2026-08-29T12:00:00.000Z',
    },
  });
}

describe('Outbox schema (PostgreSQL real)', () => {
  test('persiste o envelope completo em jsonb e le de volta intacto', async () => {
    const em = orm.em.fork();
    const event = buildProcessedEvent();
    const outbox = OutboxMessage.enqueue(event);

    const entity = new OutboxMessageEntity();
    entity.id = outbox.id;
    entity.aggregateId = outbox.aggregateId;
    entity.eventType = outbox.eventType;
    entity.payload = outbox.payload as Record<string, unknown>;
    entity.occurredAt = outbox.occurredAt;
    entity.attempts = outbox.attempts;
    entity.nextAttemptAt = outbox.nextAttemptAt;

    em.persist(entity);
    await em.flush();

    const rows = await em
      .getConnection()
      .execute<Array<{ payload: Record<string, unknown> }>>('SELECT payload FROM outbox_messages WHERE id = ?', [
        outbox.id,
      ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect(rows[0].payload.eventId).toBe(event.eventId);
    expect(rows[0].payload.correlationId).toBe(event.correlationId);
    expect(rows[0].payload.causationId).toBe(event.causationId);
    expect(rows[0].payload.version).toBe(1);
    expect((rows[0].payload.data as { money: { amount: string } }).money.amount).toBe('25.00');
  });

  test('constraint next_attempt_at rejeita uma linha publicada com next_attempt_at preenchido, mesmo via ORM', async () => {
    const em = orm.em.fork();
    const outbox = OutboxMessage.enqueue(buildProcessedEvent());

    const entity = new OutboxMessageEntity();
    entity.id = outbox.id;
    entity.aggregateId = outbox.aggregateId;
    entity.eventType = outbox.eventType;
    entity.payload = outbox.payload as Record<string, unknown>;
    entity.occurredAt = outbox.occurredAt;
    entity.attempts = outbox.attempts;
    entity.nextAttemptAt = outbox.occurredAt; // inconsistente: mantido apesar de "publicada"
    entity.publishedAt = outbox.occurredAt;

    em.persist(entity);
    await expect(em.flush()).rejects.toThrow();
  });
});

describe('Inbox schema (PostgreSQL real)', () => {
  test('persiste pela chave composta (consumerName, messageId) e le de volta', async () => {
    const em = orm.em.fork();
    const message = InboxMessage.receive({
      messageId: 'msg-schema-1',
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'hash-1',
      receivedAt: new Date('2026-08-29T12:00:00.000Z'),
    });

    const entity = new InboxMessageEntity();
    entity.consumerName = message.consumerName;
    entity.messageId = message.messageId;
    entity.payloadHash = message.payloadHash;
    entity.receivedAt = message.receivedAt;

    em.persist(entity);
    await em.flush();

    const found = await em.fork().findOneOrFail(InboxMessageEntity, {
      consumerName: 'wager-transactions-consumer',
      messageId: 'msg-schema-1',
    });

    expect(found.payloadHash).toBe('hash-1');
    expect(found.processedAt).toBeNull();
  });

  test('duplicidade de (consumerName, messageId) e rejeitada pela PK composta', async () => {
    const em = orm.em.fork();
    const first = new InboxMessageEntity();
    first.consumerName = 'wager-transactions-consumer';
    first.messageId = 'msg-schema-2';
    first.payloadHash = 'hash-a';
    first.receivedAt = new Date();
    em.persist(first);
    await em.flush();

    const em2 = orm.em.fork();
    const duplicate = new InboxMessageEntity();
    duplicate.consumerName = 'wager-transactions-consumer';
    duplicate.messageId = 'msg-schema-2';
    duplicate.payloadHash = 'hash-b';
    duplicate.receivedAt = new Date();
    em2.persist(duplicate);

    await expect(em2.flush()).rejects.toThrow();
  });
});
