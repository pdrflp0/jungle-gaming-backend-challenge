import { describe, expect, test } from 'bun:test';
import { FailureCode, WagerTransactionKind } from '../wagering/wager-transaction';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './wagering-events';

const OCCURRED_AT = new Date('2026-08-29T10:00:00.000Z');
const BASE_ENVELOPE_PROPS = {
  eventId: 'event-1',
  aggregateId: 'aggregate-1',
  correlationId: 'correlation-1',
  causationId: 'causation-1',
  occurredAt: OCCURRED_AT,
};

describe('WagerTransactionProcessed', () => {
  test('envelope completo, versao 1, occurredAt em ISO, nada regenerado', () => {
    const event = WagerTransactionProcessed.create({
      ...BASE_ENVELOPE_PROPS,
      data: {
        transactionId: 'transaction-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        providerId: 'provider-a',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        balance: { amount: '75.00', currency: 'BRL' },
        processedAt: OCCURRED_AT.toISOString(),
      },
    });

    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'aggregate-1',
      correlationId: 'correlation-1',
      causationId: 'causation-1',
      occurredAt: '2026-08-29T10:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'transaction-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        providerId: 'provider-a',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        balance: { amount: '75.00', currency: 'BRL' },
        processedAt: OCCURRED_AT.toISOString(),
      },
    });
  });

  test('causationId ausente fica undefined, nao inventado', () => {
    const event = WagerTransactionProcessed.create({
      eventId: 'event-2',
      aggregateId: 'aggregate-2',
      correlationId: 'correlation-2',
      occurredAt: OCCURRED_AT,
      data: {
        transactionId: 'transaction-2',
        walletId: 'wallet-2',
        playerId: 'player-2',
        providerId: 'provider-a',
        kind: WagerTransactionKind.Loss,
        money: { amount: '10.00', currency: 'BRL' },
        balance: { amount: '75.00', currency: 'BRL' },
        processedAt: OCCURRED_AT.toISOString(),
      },
    });

    expect(event.causationId).toBeUndefined();
  });
});

describe('WagerTransactionRejected', () => {
  test('envelope completo e versao 1', () => {
    const event = WagerTransactionRejected.create({
      ...BASE_ENVELOPE_PROPS,
      data: {
        transactionId: 'transaction-3',
        walletId: 'wallet-1',
        playerId: 'player-1',
        providerId: 'provider-a',
        kind: WagerTransactionKind.Bet,
        money: { amount: '999999.00', currency: 'BRL' },
        balance: { amount: '75.00', currency: 'BRL' },
        failureCode: FailureCode.InsufficientFunds,
      },
    });

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.version).toBe(1);
    expect(event.toJSON().data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(typeof event.toJSON().data.money.amount).toBe('string');
  });
});

describe('WalletBalanceChanged', () => {
  test('data contem exatamente os campos exigidos, dinheiro sempre como string', () => {
    const event = WalletBalanceChanged.create({
      ...BASE_ENVELOPE_PROPS,
      aggregateId: 'wallet-1',
      data: {
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });

    const envelope = event.toJSON();
    expect(envelope.eventType).toBe('WalletBalanceChanged');
    expect(envelope.version).toBe(1);
    expect(envelope.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });
});

describe('WagerTransactionPendingReference', () => {
  test('envelope completo e versao 1', () => {
    const event = WagerTransactionPendingReference.create({
      ...BASE_ENVELOPE_PROPS,
      data: {
        transactionId: 'transaction-4',
        walletId: 'wallet-1',
        playerId: 'player-1',
        providerId: 'provider-a',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet-1',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });

    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.version).toBe(1);
    expect(event.toJSON().data.referenceExternalTransactionId).toBe('ext-bet-1');
  });
});
