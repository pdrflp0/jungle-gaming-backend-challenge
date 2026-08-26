import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';

/**
 * Entidade de persistencia — separada de WalletLedgerEntry (src/domain).
 * O CHECK de aritmetica (balanceBefore +/- amount = balanceAfter) e o
 * trigger append-only vivem so na migration.
 */
@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['walletId', 'transactionId'] })
@Index({ properties: ['walletId', 'createdAt', 'id'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'string', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'string', columnType: 'uuid' })
  walletId!: string;

  @Property({ type: 'string', columnType: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', columnType: 'varchar(6)' })
  direction!: string;

  /** Guardado como string — o driver Postgres nao deve converter NUMERIC para number. */
  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  balanceBefore!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  balanceAfter!: string;

  @Property({ type: 'date', columnType: 'timestamptz' })
  createdAt!: Date;
}
