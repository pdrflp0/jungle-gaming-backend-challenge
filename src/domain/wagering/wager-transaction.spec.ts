import { describe, expect, test } from 'bun:test';
import { Money } from '../money/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import {
  FailureCode,
  InvalidReferenceError,
  InvalidTransactionStateError,
  InvalidWagerAmountError,
  LossHasNoLedgerEntryError,
  MissingReferenceError,
  MissingResolvedReferenceError,
  OpeningIsInternalError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

const BRL = 'BRL';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-01T00:05:00.000Z');

function baseProps(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: BRL }),
    createdAt: NOW,
    ...overrides,
  };
}

describe('WagerTransaction.create', () => {
  test('cria BET/WIN/LOSS pendentes, sem referencia', () => {
    for (const kind of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss]) {
      const tx = WagerTransaction.create(baseProps({ id: `tx-${kind}`, kind }));
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.kind).toBe(kind);
    }
  });

  test('cria REFUND/ROLLBACK pendentes quando a referencia esta presente', () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      const tx = WagerTransaction.create(
        baseProps({ id: `tx-${kind}`, kind, referenceExternalTransactionId: 'ext-bet' }),
      );
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
    }
  });

  test('rejeita a criacao de OPENING via create()', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Opening }))).toThrow(
      OpeningIsInternalError,
    );
  });

  test('rejeita valor zero ou negativo', () => {
    expect(() => WagerTransaction.create(baseProps({ money: Money.zero(BRL) }))).toThrow(
      InvalidWagerAmountError,
    );
    expect(() =>
      WagerTransaction.create(baseProps({ money: Money.from({ amount: '1.00', currency: BRL }).negate() })),
    ).toThrow(InvalidWagerAmountError);
  });

  test('exige referencia para REFUND e ROLLBACK', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund }))).toThrow(
      MissingReferenceError,
    );
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Rollback }))).toThrow(
      MissingReferenceError,
    );
  });
});

describe('WagerTransaction.createOpening', () => {
  test('nasce ja PROCESSED, sem passar por create()', () => {
    const opening = WagerTransaction.createOpening({
      id: 'tx-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'opening:wallet-1',
      payloadHash: 'hash-opening',
      money: Money.from({ amount: '1000.00', currency: BRL }),
      createdAt: NOW,
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.processedAt).toBe(NOW);
  });

  test('rejeita valor zero ou negativo', () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        externalTransactionId: 'opening:wallet-1',
        idempotencyKey: 'opening:wallet-1',
        payloadHash: 'hash-opening',
        money: Money.zero(BRL),
        createdAt: NOW,
      }),
    ).toThrow(InvalidWagerAmountError);
  });
});

describe('affectsBalance / requiresReference', () => {
  test('affectsBalance depende so do kind, nao do status', () => {
    const pendingBet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    expect(pendingBet.affectsBalance()).toBe(true);

    pendingBet.reject(FailureCode.InsufficientFunds);
    expect(pendingBet.affectsBalance()).toBe(true); // continua "true" como tipo; o caso de uso e' que nao aplica

    const loss = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss }));
    expect(loss.affectsBalance()).toBe(false);
  });

  test('requiresReference e true somente para REFUND e ROLLBACK', () => {
    expect(WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet })).requiresReference()).toBe(
      false,
    );
    expect(
      WagerTransaction.create(
        baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-bet' }),
      ).requiresReference(),
    ).toBe(true);
  });
});

describe('transicoes de estado', () => {
  test('markProcessed a partir de PENDING (kind sem referencia)', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.markProcessed(undefined, LATER);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBe(LATER);
  });

  test('reject e fail a partir de PENDING', () => {
    const rejected = WagerTransaction.create(baseProps({ id: 'tx-r' }));
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const failed = WagerTransaction.create(baseProps({ id: 'tx-f' }));
    failed.fail(FailureCode.InternalError);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
  });

  test('markPendingReference so e valido para REFUND/ROLLBACK, a partir de PENDING', () => {
    const refund = WagerTransaction.create(
      baseProps({
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    expect(() => bet.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('markPendingReference tambem e valido para WIN quando ela forneceu uma referencia opcional', () => {
    const win = WagerTransaction.create(
      baseProps({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-bet' }),
    );
    win.markPendingReference();
    expect(win.status).toBe(WagerTransactionStatus.PendingReference);

    // sem referencia, WIN nao tem o que esperar.
    const winSemReferencia = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win }));
    expect(() => winSemReferencia.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('markPendingReference rejeita uma segunda chamada quando ja esta em PENDING_REFERENCE', () => {
    const refund = WagerTransaction.create(
      baseProps({
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );
    refund.markPendingReference();

    expect(() => refund.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('markProcessed exige referenceTransactionId resolvido para REFUND/ROLLBACK', () => {
    const refund = WagerTransaction.create(
      baseProps({
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );

    expect(() => refund.markProcessed(undefined, LATER)).toThrow(MissingResolvedReferenceError);
    expect(refund.status).toBe(WagerTransactionStatus.Pending); // nao mudou

    refund.markProcessed('internal-bet-id', LATER);
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.referenceTransactionId).toBe('internal-bet-id');
  });

  test('markProcessed nao exige referenceTransactionId para BET, WIN, LOSS e OPENING', () => {
    const bet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    bet.markProcessed(undefined, LATER);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const win = WagerTransaction.create(baseProps({ id: 'tx-win', kind: WagerTransactionKind.Win }));
    win.markProcessed(undefined, LATER);
    expect(win.status).toBe(WagerTransactionStatus.Processed);

    const loss = WagerTransaction.create(baseProps({ id: 'tx-loss', kind: WagerTransactionKind.Loss }));
    loss.markProcessed(undefined, LATER);
    expect(loss.status).toBe(WagerTransactionStatus.Processed);

    // createOpening ja chama markProcessed(undefined, ...) internamente — ver describe proprio.
  });

  test('PENDING_REFERENCE pode ir para PROCESSED ao receber o id interno da referencia', () => {
    const rollback = WagerTransaction.create(
      baseProps({
        externalTransactionId: 'ext-rollback',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );

    rollback.markPendingReference();
    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    rollback.markProcessed('internal-bet-id', LATER);
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.referenceTransactionId).toBe('internal-bet-id');
  });

  test('nenhuma transicao e permitida a partir de um estado terminal', () => {
    const processed = WagerTransaction.create(baseProps());
    processed.markProcessed(undefined, LATER);

    expect(() => processed.markProcessed(undefined, LATER)).toThrow(InvalidTransactionStateError);
    expect(() => processed.reject(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
    expect(() => processed.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
  });

  test('isTerminal reflete PROCESSED/REJECTED/FAILED e nao PENDING/PENDING_REFERENCE', () => {
    const pending = WagerTransaction.create(baseProps());
    expect(pending.isTerminal()).toBe(false);

    pending.reject(FailureCode.InsufficientFunds);
    expect(pending.isTerminal()).toBe(true);
  });
});

describe('matchesPayload', () => {
  test('compara o hash armazenado', () => {
    const tx = WagerTransaction.create(baseProps({ payloadHash: 'hash-abc' }));
    expect(tx.matchesPayload('hash-abc')).toBe(true);
    expect(tx.matchesPayload('hash-xyz')).toBe(false);
  });
});

describe('ledgerDirectionFor', () => {
  test('OPENING e WIN sao CREDIT, BET e DEBIT', () => {
    const opening = WagerTransaction.createOpening({
      id: 'tx-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'opening:wallet-1',
      payloadHash: 'hash-opening',
      money: Money.from({ amount: '1000.00', currency: BRL }),
      createdAt: NOW,
    });
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const win = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Win }));
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const bet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  test('WIN com referencia valida e CREDIT mesmo com valor diferente da BET (premio != aposta)', () => {
    const bet = WagerTransaction.create(
      baseProps({ id: 'tx-bet', externalTransactionId: 'ext-bet', money: Money.from({ amount: '25.00', currency: BRL }) }),
    );
    bet.markProcessed(undefined, NOW);

    const win = WagerTransaction.create(
      baseProps({
        id: 'tx-win',
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'ext-bet',
        money: Money.from({ amount: '90.00', currency: BRL }), // premio bem maior que a aposta
      }),
    );

    expect(win.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test('WIN com referencia de kind errado lanca InvalidReferenceError', () => {
    const loss = WagerTransaction.create(
      baseProps({ id: 'tx-loss', kind: WagerTransactionKind.Loss, externalTransactionId: 'ext-loss' }),
    );
    loss.markProcessed(undefined, NOW);

    const win = WagerTransaction.create(
      baseProps({ id: 'tx-win', kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-loss' }),
    );

    expect(() => win.ledgerDirectionFor(loss)).toThrow(InvalidReferenceError);
  });

  test('WIN com referencia de moeda diferente lanca InvalidReferenceError', () => {
    const bet = WagerTransaction.create(
      baseProps({
        id: 'tx-bet',
        externalTransactionId: 'ext-bet',
        money: Money.from({ amount: '25.00', currency: 'USD' }),
      }),
    );
    bet.markProcessed(undefined, NOW);

    const win = WagerTransaction.create(
      baseProps({ id: 'tx-win', kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-bet' }),
    );

    expect(() => win.ledgerDirectionFor(bet)).toThrow(InvalidReferenceError);
  });

  test('LOSS lanca LossHasNoLedgerEntryError', () => {
    const loss = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss }));
    expect(() => loss.ledgerDirectionFor()).toThrow(LossHasNoLedgerEntryError);
  });

  test('REFUND e CREDIT quando a referencia e a BET realmente solicitada, valida e processada', () => {
    const bet = WagerTransaction.create(baseProps({ id: 'tx-bet', externalTransactionId: 'ext-bet' }));
    bet.markProcessed(undefined, NOW);

    const refund = WagerTransaction.create(
      baseProps({
        id: 'tx-refund',
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );

    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test('REFUND rejeita referencia com externalTransactionId diferente do solicitado', () => {
    // mesmo provider/player/wallet/moeda/rodada/valor/status/kind — so o externalTransactionId nao bate.
    const otherBet = WagerTransaction.create(
      baseProps({ id: 'tx-other-bet', externalTransactionId: 'ext-bet-outro' }),
    );
    otherBet.markProcessed(undefined, NOW);

    const refund = WagerTransaction.create(
      baseProps({
        id: 'tx-refund',
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet', // pediu "ext-bet", nao "ext-bet-outro"
      }),
    );

    expect(() => refund.ledgerDirectionFor(otherBet)).toThrow(InvalidReferenceError);
  });

  test('REFUND rejeita referencia nao processada', () => {
    const bet = WagerTransaction.create(baseProps({ id: 'tx-bet', externalTransactionId: 'ext-bet' })); // continua PENDING

    const refund = WagerTransaction.create(
      baseProps({
        id: 'tx-refund',
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );

    expect(() => refund.ledgerDirectionFor(bet)).toThrow(InvalidReferenceError);
  });

  test('REFUND rejeita referencia de kind errado (nao pode referenciar WIN)', () => {
    const win = WagerTransaction.create(
      baseProps({ id: 'tx-win', externalTransactionId: 'ext-win', kind: WagerTransactionKind.Win }),
    );
    win.markProcessed(undefined, NOW);

    const refund = WagerTransaction.create(
      baseProps({
        id: 'tx-refund',
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-win', // id bate, so o kind e' invalido para REFUND
      }),
    );

    expect(() => refund.ledgerDirectionFor(win)).toThrow(InvalidReferenceError);
  });

  test('REFUND rejeita referencia com valor diferente', () => {
    const bet = WagerTransaction.create(
      baseProps({
        id: 'tx-bet',
        externalTransactionId: 'ext-bet',
        money: Money.from({ amount: '25.00', currency: BRL }),
      }),
    );
    bet.markProcessed(undefined, NOW);

    const refund = WagerTransaction.create(
      baseProps({
        id: 'tx-refund',
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
        money: Money.from({ amount: '10.00', currency: BRL }),
      }),
    );

    expect(() => refund.ledgerDirectionFor(bet)).toThrow(InvalidReferenceError);
  });

  test('REFUND rejeita quando nao ha referencia resolvida', () => {
    const refund = WagerTransaction.create(
      baseProps({
        id: 'tx-refund',
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );

    expect(() => refund.ledgerDirectionFor(undefined)).toThrow(InvalidReferenceError);
  });

  test('ROLLBACK inverte a direcao da referencia (BET->CREDIT, WIN->DEBIT, REFUND->DEBIT)', () => {
    const bet = WagerTransaction.create(baseProps({ id: 'tx-bet', externalTransactionId: 'ext-bet' }));
    bet.markProcessed(undefined, NOW);
    const rollbackOfBet = WagerTransaction.create(
      baseProps({
        id: 'tx-rb-1',
        externalTransactionId: 'ext-rb-1',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = WagerTransaction.create(
      baseProps({ id: 'tx-win', externalTransactionId: 'ext-win', kind: WagerTransactionKind.Win }),
    );
    win.markProcessed(undefined, NOW);
    const rollbackOfWin = WagerTransaction.create(
      baseProps({
        id: 'tx-rb-2',
        externalTransactionId: 'ext-rb-2',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-win',
      }),
    );
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);

    const refund = WagerTransaction.create(
      baseProps({
        id: 'tx-refund',
        externalTransactionId: 'ext-refund',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
      }),
    );
    refund.markProcessed('internal-bet-id', NOW);
    const rollbackOfRefund = WagerTransaction.create(
      baseProps({
        id: 'tx-rb-3',
        externalTransactionId: 'ext-rb-3',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-refund',
      }),
    );
    expect(rollbackOfRefund.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK rejeita referencia de kind nao permitido (nao pode reverter OPENING)', () => {
    const opening = WagerTransaction.createOpening({
      id: 'tx-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'opening:wallet-1',
      payloadHash: 'hash-opening',
      money: Money.from({ amount: '25.00', currency: BRL }),
      createdAt: NOW,
    });

    const rollback = WagerTransaction.create(
      baseProps({
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'opening:wallet-1', // id bate, so o kind e' invalido para ROLLBACK
      }),
    );

    expect(() => rollback.ledgerDirectionFor(opening)).toThrow(InvalidReferenceError);
  });
});

describe('rehydrate', () => {
  test('restaura um estado persistido valido fielmente, sem revalidar', () => {
    const state = {
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: BRL }),
      referenceExternalTransactionId: undefined,
      createdAt: NOW,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: LATER,
    };

    const tx = WagerTransaction.rehydrate(state);

    expect(tx.id).toBe(state.id);
    expect(tx.status).toBe(state.status);
    expect(tx.processedAt).toBe(state.processedAt);
    expect(tx.money.equals(state.money)).toBe(true);
  });
});
