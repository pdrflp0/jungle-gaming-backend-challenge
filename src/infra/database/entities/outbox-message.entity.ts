import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Entidade de persistencia — separada do dominio (src/domain/messaging).
 * `aggregate_id` nao tem FK: um evento pode ser sobre uma wager_transaction
 * OU uma wallet, entao seria uma referencia polimorfica — fica como
 * referencia "macia", so para correlacao/auditoria.
 */
@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'string', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'string', columnType: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'string' })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'date', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'number', columnType: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'date', columnType: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'date', columnType: 'timestamptz', nullable: true })
  publishedAt?: Date;
}
