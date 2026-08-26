import { Migration } from '@mikro-orm/migrations';

export class Migration20260826120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount NUMERIC(19,2) NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,

        CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_min CHECK (version >= 1),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_unique UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        wallet_id UUID NOT NULL,
        player_id UUID NOT NULL,
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind VARCHAR(16) NOT NULL,
        amount NUMERIC(19,2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id TEXT NULL,
        reference_transaction_id UUID NULL,
        status VARCHAR(20) NOT NULL,
        failure_code TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NULL,

        CONSTRAINT wager_transactions_amount_positive CHECK (amount > 0),
        CONSTRAINT wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_transactions_kind_valid CHECK (
          kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        CONSTRAINT wager_transactions_status_valid CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),

        CONSTRAINT wager_transactions_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),

        -- FK composta: uma transacao so pode apontar para uma wallet cuja moeda bate com a sua.
        CONSTRAINT wager_transactions_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wager_transactions_reference_fk
          FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),

        CONSTRAINT wager_transactions_reference_required_on_create CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
        ),
        CONSTRAINT wager_transactions_reference_required_when_processed CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK') OR status <> 'PROCESSED' OR reference_transaction_id IS NOT NULL
        ),

        CONSTRAINT wager_transactions_processed_at_consistency CHECK (
          (status = 'PROCESSED' AND processed_at IS NOT NULL) OR
          (status <> 'PROCESSED' AND processed_at IS NULL)
        ),
        CONSTRAINT wager_transactions_failure_code_consistency CHECK (
          (status IN ('REJECTED', 'FAILED') AND failure_code IS NOT NULL) OR
          (status NOT IN ('REJECTED', 'FAILED') AND failure_code IS NULL)
        )
      );
    `);

    this.addSql(`
      -- impede processar duas vezes o mesmo tipo de reversao sobre a mesma referencia interna.
      CREATE UNIQUE INDEX wager_transactions_reference_kind_unique
        ON wager_transactions (reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND kind IN ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_wallet_created_idx
        ON wager_transactions (wallet_id, created_at, id);
    `);

    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (created_at, id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction VARCHAR(6) NOT NULL,
        amount NUMERIC(19,2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(19,2) NOT NULL,
        balance_after NUMERIC(19,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,

        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT wallet_ledger_entries_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        ),

        CONSTRAINT wallet_ledger_entries_wallet_currency_fk
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wallet_ledger_entries_transaction_fk
          FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),
        CONSTRAINT wallet_ledger_entries_wallet_transaction_unique UNIQUE (wallet_id, transaction_id)
      );
    `);

    this.addSql(`
      CREATE INDEX wallet_ledger_entries_wallet_created_idx
        ON wallet_ledger_entries (wallet_id, created_at, id);
    `);

    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_append_only ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_ledger_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
