import { describe, expect, test } from 'bun:test';
import { OutboxMessage, OutboxMessageAlreadyPublishedError } from './outbox-message';
import { WagerTransactionProcessed } from './wagering-events';

const OCCURRED_AT = new Date('2026-08-29T10:00:00.000Z');

function buildEvent() {
  return WagerTransactionProcessed.create({
    eventId: 'event-1',
    aggregateId: 'transaction-1',
    correlationId: 'correlation-1',
    occurredAt: OCCURRED_AT,
    data: {
      transactionId: 'transaction-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-a',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
      processedAt: OCCURRED_AT.toISOString(),
    },
  });
}

describe('OutboxMessage', () => {
  test('enqueue nasce pendente e imediatamente devida', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());

    expect(outbox.isPending()).toBe(true);
    expect(outbox.attempts).toBe(0);
    expect(outbox.nextAttemptAt).toEqual(OCCURRED_AT);
    expect(outbox.isDue(OCCURRED_AT)).toBe(true);
  });

  test('enqueue preserva o evento recebido: id, eventType e envelope completo como payload', () => {
    const event = buildEvent();
    const outbox = OutboxMessage.enqueue(event);

    expect(outbox.id).toBe(event.eventId);
    expect(outbox.aggregateId).toBe(event.aggregateId);
    expect(outbox.eventType).toBe(event.eventType);
    expect(outbox.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    // o envelope completo, nao so o data
    expect(outbox.payload).toHaveProperty('eventId', event.eventId);
    expect(outbox.payload).toHaveProperty('correlationId', event.correlationId);
    expect(outbox.payload).toHaveProperty('version', 1);
  });

  test('isDue e falso antes do horario e verdadeiro depois', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    const before = new Date(OCCURRED_AT.getTime() - 1000);
    const after = new Date(OCCURRED_AT.getTime() + 1000);

    expect(outbox.isDue(before)).toBe(false);
    expect(outbox.isDue(after)).toBe(true);
  });

  test('scheduleRetry incrementa attempts e aplica o backoff proprio da Outbox', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    const now = new Date('2026-08-29T10:10:00.000Z');

    outbox.scheduleRetry(now);

    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt).toEqual(new Date(now.getTime() + 5000));
    expect(outbox.isPending()).toBe(true);
  });

  test('markPublished e terminal: preenche publishedAt e limpa nextAttemptAt', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    const publishedAt = new Date('2026-08-29T10:15:00.000Z');

    outbox.markPublished(publishedAt);

    expect(outbox.isPending()).toBe(false);
    expect(outbox.publishedAt).toEqual(publishedAt);
    expect(outbox.nextAttemptAt).toBeUndefined();
    expect(outbox.isDue(new Date('2100-01-01T00:00:00.000Z'))).toBe(false);
  });

  test('markPublished recusa uma segunda publicacao', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    outbox.markPublished(new Date('2026-08-29T10:15:00.000Z'));

    expect(() => outbox.markPublished(new Date('2026-08-29T10:16:00.000Z'))).toThrow(
      OutboxMessageAlreadyPublishedError,
    );
  });

  test('scheduleRetry recusa rodar depois de publicada', () => {
    const outbox = OutboxMessage.enqueue(buildEvent());
    outbox.markPublished(new Date('2026-08-29T10:15:00.000Z'));

    expect(() => outbox.scheduleRetry(new Date('2026-08-29T10:16:00.000Z'))).toThrow(
      OutboxMessageAlreadyPublishedError,
    );
  });

  test('rehydrate reconstroi sem revalidar', () => {
    const state = {
      id: 'event-2',
      aggregateId: 'transaction-2',
      eventType: 'WagerTransactionProcessed',
      payload: { eventId: 'event-2' },
      occurredAt: OCCURRED_AT,
      attempts: 3,
      nextAttemptAt: new Date('2026-08-29T11:00:00.000Z'),
      publishedAt: undefined,
    };

    const outbox = OutboxMessage.rehydrate(state);

    expect(outbox.id).toBe(state.id);
    expect(outbox.attempts).toBe(3);
    expect(outbox.nextAttemptAt).toEqual(state.nextAttemptAt);
    expect(outbox.isPending()).toBe(true);
  });
});
