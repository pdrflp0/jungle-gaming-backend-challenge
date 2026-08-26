import { Money } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
  opening?: {
    transactionId: string;
    entryId: string;
  };
}

export interface OpenWalletResult {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

export interface WalletMovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  now: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class WalletCurrencyMismatchError extends Error {
  constructor(walletCurrency: string, moneyCurrency: string) {
    super(`Wallet currency ${walletCurrency} does not match money currency ${moneyCurrency}`);
    this.name = 'WalletCurrencyMismatchError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} has insufficient funds for this debit`);
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidMovementAmountError extends Error {
  constructor(money: Money) {
    super(`Movement amount must be strictly positive: ${money.toString()}`);
    this.name = 'InvalidMovementAmountError';
  }
}

export class InvalidInitialBalanceError extends Error {
  constructor(initialBalance: Money) {
    super(`Initial balance cannot be negative: ${initialBalance.toString()}`);
    this.name = 'InvalidInitialBalanceError';
  }
}

export class MissingOpeningDataError extends Error {
  constructor() {
    super('Opening data (transactionId and entryId) is required when initialBalance is positive');
    this.name = 'MissingOpeningDataError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenWalletResult {
    if (props.initialBalance.isNegative()) {
      throw new InvalidInitialBalanceError(props.initialBalance);
    }

    // saldo zero nunca usa dados de abertura, mesmo se fornecidos por engano.
    const opening = props.initialBalance.isPositive() ? props.opening : undefined;

    if (props.initialBalance.isPositive() && !opening) {
      throw new MissingOpeningDataError();
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );

    if (!opening) {
      return { wallet };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: wallet.id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(props.initialBalance.currency),
      balanceAfter: props.initialBalance,
      createdAt: props.now,
    });

    return { wallet, openingEntry };
  }

  /** Reconstrucao a partir da persistencia — nao revalida, so reconstroi. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidMovementAmountError(props.money);
    }

    const balanceAfter = this._balance.subtract(props.money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(this.id);
    }

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.now;

    return entry;
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidMovementAmountError(props.money);
    }

    const balanceAfter = this._balance.add(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.now;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new WalletCurrencyMismatchError(this.currency, money.currency);
    }
  }
}
