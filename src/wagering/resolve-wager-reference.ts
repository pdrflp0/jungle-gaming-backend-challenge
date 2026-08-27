import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money, MoneyAmountOverflowError } from '../domain/money/money';
import { InsufficientFundsError, Wallet, WalletCurrencyMismatchError } from '../domain/wallet/wallet';
import { LedgerDirection } from '../domain/wallet/wallet-ledger-entry';
import {
  FailureCode,
  InvalidReferenceError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction';
import {
  insertLedgerEntry,
  selectExistingReversal,
  updateWagerTransactionOutcome,
  updateWalletBalance,
  wagerTransactionRowToDomain,
  WagerTransactionRow,
} from './wager-transaction.sql';

export interface ReferenceAwareOutcome {
  status: WagerTransactionStatus;
  balance: Money;
}

/**
 * Aplica (ou rejeita) uma WIN/REFUND/ROLLBACK cuja referencia ja esta
 * resolvida — ou porque a kind nunca teve referencia (nao chega aqui nesse
 * caso, ver chamadores), ou porque a linha referenciada e TERMINAL
 * (PROCESSED/REJECTED/FAILED). NUNCA chame isto com uma referencia ainda
 * PENDING_REFERENCE: quem decide "ainda nao da para saber, continue
 * esperando" e o chamador (fluxo HTTP ou worker), antes de chegar aqui.
 *
 * Usado tanto pelo fluxo HTTP sincrono (Bloco 7a) quanto pelo worker de
 * reprocessamento (Bloco 7b) — mesma regra financeira, um lugar so.
 * Pressupoe que a wallet e a WagerTransaction ja foram carregadas com a
 * wallet travada (FOR UPDATE) na transacao corrente.
 */
export async function applyReferenceAwareOutcome(
  em: EntityManager,
  transaction: WagerTransaction,
  wallet: Wallet,
  referenceRow: WagerTransactionRow | undefined,
  now: Date,
): Promise<ReferenceAwareOutcome> {
  const referenceDomain = referenceRow ? wagerTransactionRowToDomain(referenceRow) : undefined;

  try {
    const direction = transaction.ledgerDirectionFor(referenceDomain);

    // So se aplica a REFUND/ROLLBACK, os unicos kinds com a constraint
    // UNIQUE(reference_transaction_id, kind).
    let alreadyReversed = false;
    if (
      referenceDomain &&
      (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback)
    ) {
      alreadyReversed = await selectExistingReversal(em, referenceDomain.id, transaction.kind);
    }

    if (alreadyReversed) {
      transaction.reject(FailureCode.ReferenceAlreadyReversed);
    } else {
      const ledgerEntry =
        direction === LedgerDirection.Credit
          ? wallet.credit({ money: transaction.money, transactionId: transaction.id, entryId: randomUUID(), now })
          : wallet.debit({ money: transaction.money, transactionId: transaction.id, entryId: randomUUID(), now });
      transaction.markProcessed(referenceDomain?.id, now);
      await updateWalletBalance(em, wallet);
      await insertLedgerEntry(em, ledgerEntry);
    }
  } catch (error) {
    if (error instanceof InvalidReferenceError) {
      transaction.reject(FailureCode.InvalidReference);
    } else if (error instanceof InsufficientFundsError) {
      transaction.reject(
        transaction.kind === WagerTransactionKind.Rollback
          ? FailureCode.ReversalWouldMakeBalanceNegative
          : FailureCode.InsufficientFunds,
      );
    } else if (error instanceof WalletCurrencyMismatchError) {
      transaction.reject(FailureCode.CurrencyMismatch);
    } else if (error instanceof MoneyAmountOverflowError) {
      transaction.reject(FailureCode.BalanceLimitExceeded);
    } else {
      throw error;
    }
  }

  await updateWagerTransactionOutcome(em, transaction, wallet.balance);
  return { status: transaction.status, balance: wallet.balance };
}
