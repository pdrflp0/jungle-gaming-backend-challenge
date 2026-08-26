import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

/**
 * Entidade de persistencia — separada das classes de dominio (src/domain).
 * Nao contem regra de negocio; so descreve as colunas da tabela `wallets`.
 * As constraints de verdade (CHECK, UNIQUE, trigger) vivem na migration.
 */
@Entity({ tableName: 'wallets' })
@Unique({ properties: ['id', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'string', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'string', columnType: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  /** Guardado como string — o driver Postgres nao deve converter NUMERIC para number. */
  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  balanceAmount!: string;

  @Property({ type: 'number' })
  version!: number;

  @Property({ type: 'date', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'date', columnType: 'timestamptz' })
  updatedAt!: Date;
}
