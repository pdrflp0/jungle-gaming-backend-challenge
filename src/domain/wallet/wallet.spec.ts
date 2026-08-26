import { describe, expect, test } from 'bun:test';
import { Money } from '../money/money';
import { LedgerDirection } from './wallet-ledger-entry';
import {
  InsufficientFundsError,
  InvalidInitialBalanceError,
  InvalidMovementAmountError,
  MissingOpeningDataError,
  Wallet,
  WalletCurrencyMismatchError,
} from './wallet';

const BRL = 'BRL';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-01T00:05:00.000Z');

function openFundedWallet() {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '100.00', currency: BRL }),
    now: NOW,
    opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
  }).wallet;
}

describe('Wallet.open', () => {
  test('abre com saldo zero, sem lancamento de abertura', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero(BRL),
      now: NOW,
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(NOW);
    expect(openingEntry).toBeUndefined();
  });

  test('ignora dados de opening fornecidos acidentalmente quando o saldo inicial e zero', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero(BRL),
      now: NOW,
      opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('abre com saldo positivo e produz o lancamento CREDIT de abertura', () => {
    const initialBalance = Money.from({ amount: '1000.00', currency: BRL });

    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance,
      now: NOW,
      opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
    });

    expect(wallet.balance.equals(initialBalance)).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(initialBalance)).toBe(true);
    expect(openingEntry?.isBalanced()).toBe(true);
    expect(openingEntry?.createdAt).toBe(NOW);
  });

  test('exige opening quando o saldo inicial e positivo', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.from({ amount: '100.00', currency: BRL }),
        now: NOW,
      }),
    ).toThrow(MissingOpeningDataError);
  });

  test('rejeita saldo inicial negativo', () => {
    const negative = Money.from({ amount: '100.00', currency: BRL }).negate();

    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: negative,
        now: NOW,
      }),
    ).toThrow(InvalidInitialBalanceError);
  });
});

describe('Wallet.credit', () => {
  test('aumenta o saldo e produz um lancamento CREDIT balanceado', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.zero(BRL),
      now: NOW,
    });

    const entry = wallet.credit({
      money: Money.from({ amount: '50.00', currency: BRL }),
      transactionId: 'tx-1',
      entryId: 'entry-1',
      now: LATER,
    });

    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(LATER);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });
});

describe('Wallet.debit', () => {
  test('debita com saldo suficiente e produz um lancamento DEBIT balanceado', () => {
    const wallet = openFundedWallet();

    const entry = wallet.debit({
      money: Money.from({ amount: '80.00', currency: BRL }),
      transactionId: 'tx-1',
      entryId: 'entry-1',
      now: LATER,
    });

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita debito com saldo insuficiente e nao muda nada', () => {
    const wallet = openFundedWallet();

    expect(() =>
      wallet.debit({
        money: Money.from({ amount: '150.00', currency: BRL }),
        transactionId: 'tx-1',
        entryId: 'entry-1',
        now: LATER,
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(NOW);
  });

  test('rejeita moeda diferente da wallet e nao muda nada', () => {
    const wallet = openFundedWallet();

    expect(() =>
      wallet.debit({
        money: Money.from({ amount: '10.00', currency: 'USD' }),
        transactionId: 'tx-1',
        entryId: 'entry-1',
        now: LATER,
      }),
    ).toThrow(WalletCurrencyMismatchError);

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('rejeita movimentacao com valor zero e nao muda nada', () => {
    const wallet = openFundedWallet();

    expect(() =>
      wallet.debit({
        money: Money.zero(BRL),
        transactionId: 'tx-1',
        entryId: 'entry-1',
        now: LATER,
      }),
    ).toThrow(InvalidMovementAmountError);

    expect(wallet.version).toBe(1);
  });

  test('rejeita movimentacao com valor negativo e nao muda nada', () => {
    const wallet = openFundedWallet();
    const negative = Money.from({ amount: '10.00', currency: BRL }).negate();

    expect(() =>
      wallet.credit({
        money: negative,
        transactionId: 'tx-1',
        entryId: 'entry-1',
        now: LATER,
      }),
    ).toThrow(InvalidMovementAmountError);

    expect(wallet.version).toBe(1);
  });

  test('duas apostas sequenciais de 80 sobre saldo 100 — prova a regra de negocio, nao concorrencia real', () => {
    const wallet = openFundedWallet();

    wallet.debit({
      money: Money.from({ amount: '80.00', currency: BRL }),
      transactionId: 'tx-1',
      entryId: 'entry-1',
      now: LATER,
    });

    expect(() =>
      wallet.debit({
        money: Money.from({ amount: '80.00', currency: BRL }),
        transactionId: 'tx-2',
        entryId: 'entry-2',
        now: LATER,
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe('20.00');
  });
});

describe('Wallet.rehydrate', () => {
  test('restaura um estado persistido valido fielmente, sem executar uma nova transicao', () => {
    const state = {
      id: 'wallet-1',
      playerId: 'player-1',
      currency: BRL,
      balance: Money.from({ amount: '42.50', currency: BRL }),
      version: 3,
      createdAt: NOW,
      updatedAt: LATER,
    };

    const wallet = Wallet.rehydrate(state);

    expect(wallet.id).toBe(state.id);
    expect(wallet.playerId).toBe(state.playerId);
    expect(wallet.currency).toBe(state.currency);
    expect(wallet.balance.equals(state.balance)).toBe(true);
    expect(wallet.version).toBe(state.version);
    expect(wallet.createdAt).toBe(state.createdAt);
    expect(wallet.updatedAt).toBe(state.updatedAt);
  });
});
