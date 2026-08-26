import { Money } from '../money/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalWouldMakeBalanceNegative = 'REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE',
  InvalidReference = 'INVALID_REFERENCE',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  InternalError = 'INTERNAL_ERROR',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningWagerTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

/** OPENING nao vem de provider nem de rodada — usa valores internos fixos e deterministicos. */
const INTERNAL = 'internal';

export class OpeningIsInternalError extends Error {
  constructor() {
    super('OPENING transactions cannot be created through create() — use createOpening()');
    this.name = 'OpeningIsInternalError';
  }
}

export class InvalidWagerAmountError extends Error {
  constructor(money: Money) {
    super(`Wager amount must be strictly positive: ${money.toString()}`);
    this.name = 'InvalidWagerAmountError';
  }
}

export class MissingReferenceError extends Error {
  constructor(kind: WagerTransactionKind) {
    super(`${kind} requires referenceExternalTransactionId`);
    this.name = 'MissingReferenceError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(status: WagerTransactionStatus) {
    super(`Cannot transition a transaction that is already terminal (${status})`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class LossHasNoLedgerEntryError extends Error {
  constructor() {
    super('LOSS never produces a ledger entry');
    this.name = 'LossHasNoLedgerEntryError';
  }
}

export class InvalidReferenceError extends Error {
  constructor() {
    super('Reference transaction is incompatible with this operation');
    this.name = 'InvalidReferenceError';
  }
}

export class MissingResolvedReferenceError extends Error {
  constructor(kind: WagerTransactionKind) {
    super(`${kind} cannot be marked as processed without a resolved referenceTransactionId`);
    this.name = 'MissingResolvedReferenceError';
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new OpeningIsInternalError();
    }

    if (!props.money.isPositive()) {
      throw new InvalidWagerAmountError(props.money);
    }

    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;

    if (needsReference && !props.referenceExternalTransactionId) {
      throw new MissingReferenceError(props.kind);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Unico caminho para nascer OPENING — nunca exposto a API ou fila. Ja nasce PROCESSED. */
  static createOpening(props: CreateOpeningWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerAmountError(props.money);
    }

    const transaction = new WagerTransaction(
      props.id,
      INTERNAL,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      INTERNAL,
      INTERNAL,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );

    transaction.markProcessed(undefined, props.createdAt);
    return transaction;
  }

  /** Reconstrucao a partir da persistencia — nao revalida, so reconstroi. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();

    if (this.requiresReference() && !referenceTransactionId) {
      throw new MissingResolvedReferenceError(this.kind);
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status);
    }

    // Baseado no campo de verdade (existe uma referencia para esperar?), nao
    // no kind — WIN pode ter uma referencia opcional e tambem precisa poder
    // esperar por ela, mesmo nao sendo um kind que "exige" referencia.
    if (!this.hasReference()) {
      throw new InvalidTransactionStateError(this._status);
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /** Depende so do kind — uma BET PENDING ja "afeta saldo" como tipo; REJECTED so nao e aplicada. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Diferente de requiresReference(): WIN nao exige referencia, mas pode ter uma (opcional). */
  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Win:
        // Referencia e opcional para WIN. Se vier, valida (mesmo provider/
        // player/wallet/moeda/rodada, BET PROCESSED) mas NAO exige o mesmo
        // valor — um premio pode ser diferente da aposta.
        if (reference) {
          this.assertValidReference(reference, [WagerTransactionKind.Bet], { requireExactAmount: false });
        }
        return LedgerDirection.Credit;

      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Loss:
        throw new LossHasNoLedgerEntryError();

      case WagerTransactionKind.Refund:
        this.assertValidReference(reference, [WagerTransactionKind.Bet]);
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback: {
        this.assertValidReference(reference, [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ]);
        const referenceDirection =
          reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit;
        return referenceDirection === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;
      }
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status);
    }
  }

  private assertValidReference(
    reference: WagerTransaction | undefined,
    allowedKinds: WagerTransactionKind[],
    options: { requireExactAmount: boolean } = { requireExactAmount: true },
  ): asserts reference is WagerTransaction {
    if (
      !reference ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.status !== WagerTransactionStatus.Processed ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency ||
      (options.requireExactAmount && !reference.money.equals(this.money)) ||
      !allowedKinds.includes(reference.kind)
    ) {
      throw new InvalidReferenceError();
    }
  }
}
