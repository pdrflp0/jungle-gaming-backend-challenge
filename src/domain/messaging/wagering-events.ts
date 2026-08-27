import { MoneyProps } from '../money/money';
import { FailureCode, WagerTransactionKind } from '../wagering/wager-transaction';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { IntegrationEvent, IntegrationEventProps } from './integration-event';

/**
 * As quatro classes concretas exigidas pelo CHALLENGE.md secao 11. `kind` e
 * `failureCode` usam os enums reais do dominio (nao `string`) — assim o
 * TypeScript recusa qualquer valor que nao seja um membro real do enum nos
 * pontos de criacao do evento, sem precisar de validacao manual em runtime.
 * Todo campo monetario e MoneyProps (string), nunca instancia de Money nem
 * number.
 */

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static create(props: IntegrationEventProps<WagerTransactionProcessedData>): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static create(props: IntegrationEventProps<WagerTransactionRejectedData>): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}

/** Campos exigidos literalmente pelo ajuste vinculante do Bloco 9a.1. */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static create(props: IntegrationEventProps<WalletBalanceChangedData>): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  money: MoneyProps;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static create(props: IntegrationEventProps<WagerTransactionPendingReferenceData>): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}
