import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/**
 * Entidade de persistencia — separada do dominio (src/domain/messaging).
 * Identidade real: PK composta (consumerName, messageId) — nao existe id
 * substituto, para casar exatamente com a garantia de unicidade exigida.
 */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string' })
  consumerName!: string;

  @PrimaryKey({ type: 'string' })
  messageId!: string;

  @Property({ type: 'string' })
  payloadHash!: string;

  @Property({ type: 'date', columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({ type: 'date', columnType: 'timestamptz', nullable: true })
  processedAt?: Date;
}
