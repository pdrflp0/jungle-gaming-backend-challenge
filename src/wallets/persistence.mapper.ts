import { Wallet } from '../domain/wallet/wallet';
import { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import { WagerTransactionEntity } from '../infra/database/entities/wager-transaction.entity';
import { WalletEntity } from '../infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../infra/database/entities/wallet-ledger-entry.entity';

/**
 * Conversao explicita dominio -> entidade de persistencia. Funcoes puras,
 * sem interface generica de "mapper" — cada uma so sabe converter o seu tipo.
 */

export function toWalletEntity(wallet: Wallet): WalletEntity {
  const entity = new WalletEntity();
  entity.id = wallet.id;
  entity.playerId = wallet.playerId;
  entity.currency = wallet.currency;
  entity.balanceAmount = wallet.balance.toJSON().amount;
  entity.version = wallet.version;
  entity.createdAt = wallet.createdAt;
  entity.updatedAt = wallet.updatedAt;
  return entity;
}

export function toWagerTransactionEntity(tx: WagerTransaction): WagerTransactionEntity {
  const entity = new WagerTransactionEntity();
  entity.id = tx.id;
  entity.providerId = tx.providerId;
  entity.externalTransactionId = tx.externalTransactionId;
  entity.idempotencyKey = tx.idempotencyKey;
  entity.payloadHash = tx.payloadHash;
  entity.walletId = tx.walletId;
  entity.playerId = tx.playerId;
  entity.roundId = tx.roundId;
  entity.gameId = tx.gameId;
  entity.kind = tx.kind;
  entity.amount = tx.money.toJSON().amount;
  entity.currency = tx.money.currency;
  entity.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  entity.referenceTransactionId = tx.referenceTransactionId;
  entity.status = tx.status;
  entity.failureCode = tx.failureCode;
  entity.createdAt = tx.createdAt;
  entity.processedAt = tx.processedAt;
  return entity;
}

export function toLedgerEntryEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
  const entity = new WalletLedgerEntryEntity();
  entity.id = entry.id;
  entity.walletId = entry.walletId;
  entity.transactionId = entry.transactionId;
  entity.direction = entry.direction;
  entity.amount = entry.money.toJSON().amount;
  entity.currency = entry.money.currency;
  entity.balanceBefore = entry.balanceBefore.toJSON().amount;
  entity.balanceAfter = entry.balanceAfter.toJSON().amount;
  entity.createdAt = entry.createdAt;
  return entity;
}
