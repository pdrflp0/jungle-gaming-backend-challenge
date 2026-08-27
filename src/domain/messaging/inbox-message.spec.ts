import { describe, expect, test } from 'bun:test';
import { InboxMessage, InboxMessageAlreadyProcessedError } from './inbox-message';

function receive() {
  return InboxMessage.receive({
    messageId: 'msg-1',
    consumerName: 'wager-transactions-consumer',
    payloadHash: 'hash-1',
    receivedAt: new Date('2026-08-29T10:00:00.000Z'),
  });
}

describe('InboxMessage', () => {
  test('nasce nao processada', () => {
    const message = receive();
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('markProcessed marca o instante e vira processada', () => {
    const message = receive();
    const at = new Date('2026-08-29T10:05:00.000Z');
    message.markProcessed(at);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at);
  });

  test('markProcessed recusa uma segunda finalizacao', () => {
    const message = receive();
    message.markProcessed(new Date('2026-08-29T10:05:00.000Z'));
    expect(() => message.markProcessed(new Date('2026-08-29T10:06:00.000Z'))).toThrow(
      InboxMessageAlreadyProcessedError,
    );
  });

  test('rehydrate reconstroi sem revalidar, inclusive ja processada', () => {
    const state = {
      messageId: 'msg-2',
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'hash-2',
      receivedAt: new Date('2026-08-29T09:00:00.000Z'),
      processedAt: new Date('2026-08-29T09:01:00.000Z'),
    };

    const message = InboxMessage.rehydrate(state);

    expect(message.messageId).toBe(state.messageId);
    expect(message.consumerName).toBe(state.consumerName);
    expect(message.payloadHash).toBe(state.payloadHash);
    expect(message.receivedAt).toEqual(state.receivedAt);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(state.processedAt);
  });
});
