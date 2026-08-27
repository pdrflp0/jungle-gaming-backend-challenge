import { Migration } from '@mikro-orm/migrations';

/**
 * Suporte ao worker de reprocessamento do Bloco 7b: toda transacao
 * PENDING_REFERENCE passa a carregar quantas vezes o worker ja tentou
 * resolver a referencia (`attempts`) e quando ele deve tentar de novo
 * (`next_attempt_at`).
 *
 * A migration precisa lidar com linhas PENDING_REFERENCE que ja existam
 * (criadas pelo Bloco 7a, antes de `next_attempt_at` existir): por isso
 * primeiro adiciona as colunas (nullable), so depois faz o backfill, e so
 * entao cria a constraint que exige a coluna preenchida — nessa ordem a
 * constraint nunca encontra uma linha que a viole.
 */
export class Migration20260828000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN next_attempt_at TIMESTAMPTZ NULL;
    `);

    // Backfill: qualquer PENDING_REFERENCE que ja existisse antes desta
    // migration passa a estar devida imediatamente — o worker pega no
    // proximo tick, com attempts=0 (valor do DEFAULT acima).
    this.addSql(`
      UPDATE wager_transactions SET next_attempt_at = now() WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_attempts_non_negative CHECK (attempts >= 0);
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_next_attempt_consistency CHECK (
          (status = 'PENDING_REFERENCE' AND next_attempt_at IS NOT NULL) OR
          (status <> 'PENDING_REFERENCE' AND next_attempt_at IS NULL)
        );
    `);

    // Substitui o indice parcial do Bloco 7a (ordenado por created_at, que so
    // servia para leitura manual) pelo indice que o worker realmente usa para
    // encontrar o proximo trabalho: "quem esta devido agora", em ordem.
    this.addSql(`DROP INDEX wager_transactions_pending_reference_idx;`);

    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_due_idx
        ON wager_transactions (next_attempt_at, id)
        WHERE status = 'PENDING_REFERENCE';
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP INDEX wager_transactions_pending_reference_due_idx;`);

    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (created_at, id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT wager_transactions_next_attempt_consistency;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT wager_transactions_attempts_non_negative;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        DROP COLUMN attempts,
        DROP COLUMN next_attempt_at;
    `);
  }
}
