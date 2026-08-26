import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';

/**
 * Entidade de persistencia — separada de WagerTransaction (src/domain).
 * As CHECKs de kind/status/referencia e os indices parciais vivem so na
 * migration; nao ha decorator padrao do MikroORM para essas duas coisas.
 */
@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
@Unique({ properties: ['idempotencyKey'] })
@Index({ properties: ['walletId', 'createdAt', 'id'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'string', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'string' })
  providerId!: string;

  @Property({ type: 'string' })
  externalTransactionId!: string;

  @Property({ type: 'string' })
  idempotencyKey!: string;

  @Property({ type: 'string' })
  payloadHash!: string;

  @Property({ type: 'string', columnType: 'uuid' })
  walletId!: string;

  @Property({ type: 'string', columnType: 'uuid' })
  playerId!: string;

  @Property({ type: 'string' })
  roundId!: string;

  @Property({ type: 'string' })
  gameId!: string;

  @Property({ type: 'string', columnType: 'varchar(16)' })
  kind!: string;

  /** Guardado como string — o driver Postgres nao deve converter NUMERIC para number. */
  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'string', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'string', columnType: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ type: 'string', columnType: 'varchar(20)' })
  status!: string;

  @Property({ type: 'string', nullable: true })
  failureCode?: string;

  @Property({ type: 'date', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'date', columnType: 'timestamptz', nullable: true })
  processedAt?: Date;
}
