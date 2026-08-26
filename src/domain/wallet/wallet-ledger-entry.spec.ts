import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../money/money';
import {
  InvalidLedgerEntryAmountError,
  LedgerDirection,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

const BRL = 'BRL';
const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('WalletLedgerEntry.create', () => {
  test('cria um lancamento CREDIT balanceado', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '100.00', currency: BRL }),
      balanceBefore: Money.zero(BRL),
      balanceAfter: Money.from({ amount: '100.00', currency: BRL }),
      createdAt: NOW,
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('cria um lancamento DEBIT balanceado', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-2',
      walletId: 'wallet-1',
      transactionId: 'tx-2',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '80.00', currency: BRL }),
      balanceBefore: Money.from({ amount: '100.00', currency: BRL }),
      balanceAfter: Money.from({ amount: '20.00', currency: BRL }),
      createdAt: NOW,
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita lancamento cuja aritmetica nao bate', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-3',
        walletId: 'wallet-1',
        transactionId: 'tx-3',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '80.00', currency: BRL }),
        balanceBefore: Money.from({ amount: '100.00', currency: BRL }),
        balanceAfter: Money.from({ amount: '30.00', currency: BRL }), // deveria ser 20.00
        createdAt: NOW,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('propaga CurrencyMismatchError do Money quando as moedas divergem', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-4',
        walletId: 'wallet-1',
        transactionId: 'tx-4',
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '10.00', currency: 'USD' }),
        balanceBefore: Money.zero(BRL),
        balanceAfter: Money.from({ amount: '10.00', currency: BRL }),
        createdAt: NOW,
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('rejeita money zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-5',
        walletId: 'wallet-1',
        transactionId: 'tx-5',
        direction: LedgerDirection.Credit,
        money: Money.zero(BRL),
        balanceBefore: Money.zero(BRL),
        balanceAfter: Money.zero(BRL),
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryAmountError);
  });

  test('rejeita money negativo', () => {
    const negative = Money.from({ amount: '10.00', currency: BRL }).negate();

    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-6',
        walletId: 'wallet-1',
        transactionId: 'tx-6',
        direction: LedgerDirection.Credit,
        money: negative,
        balanceBefore: Money.zero(BRL),
        balanceAfter: Money.zero(BRL),
        createdAt: NOW,
      }),
    ).toThrow(InvalidLedgerEntryAmountError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('restaura um estado persistido valido fielmente, sem revalidar', () => {
    const state = {
      id: 'entry-7',
      walletId: 'wallet-1',
      transactionId: 'tx-7',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.00', currency: BRL }),
      balanceBefore: Money.from({ amount: '100.00', currency: BRL }),
      balanceAfter: Money.from({ amount: '75.00', currency: BRL }),
      createdAt: NOW,
    };

    const entry = WalletLedgerEntry.rehydrate(state);

    expect(entry.id).toBe(state.id);
    expect(entry.walletId).toBe(state.walletId);
    expect(entry.transactionId).toBe(state.transactionId);
    expect(entry.direction).toBe(state.direction);
    expect(entry.money.equals(state.money)).toBe(true);
    expect(entry.balanceBefore.equals(state.balanceBefore)).toBe(true);
    expect(entry.balanceAfter.equals(state.balanceAfter)).toBe(true);
    expect(entry.createdAt).toBe(state.createdAt);
  });
});
