import { Migration } from '@mikro-orm/migrations';

/**
 * Fundacao de schema do Bloco 9a.1 (CHALLENGE.md secao 6.5): Inbox e Outbox.
 * Nenhum codigo de aplicacao usa estas tabelas ainda — o consumidor (9b) e o
 * publisher (9c) vem depois. So o schema e as constraints nascem aqui.
 */
export class Migration20260829000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id     VARCHAR NOT NULL,
        consumer_name  VARCHAR NOT NULL,
        payload_hash   VARCHAR NOT NULL,
        received_at    TIMESTAMPTZ NOT NULL,
        processed_at   TIMESTAMPTZ NULL,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              UUID PRIMARY KEY,
        aggregate_id    UUID NOT NULL,
        event_type      VARCHAR NOT NULL,
        payload         JSONB NOT NULL,
        occurred_at     TIMESTAMPTZ NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at    TIMESTAMPTZ NULL,
        CONSTRAINT outbox_messages_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_messages_next_attempt_consistency CHECK (
          (published_at IS NULL AND next_attempt_at IS NOT NULL) OR
          (published_at IS NOT NULL AND next_attempt_at IS NULL)
        )
      );
    `);

    // Indice que o futuro publisher (9c) vai usar para achar "o que esta
    // devido agora" com FOR UPDATE SKIP LOCKED — mesmo idioma do 7b.
    this.addSql(`
      CREATE INDEX outbox_messages_pending_due_idx
        ON outbox_messages (next_attempt_at, id)
        WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX outbox_messages_pending_due_idx;`);
    this.addSql(`DROP TABLE outbox_messages;`);
    this.addSql(`DROP TABLE inbox_messages;`);
  }
}
