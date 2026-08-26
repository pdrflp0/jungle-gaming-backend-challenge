import { Migration } from '@mikro-orm/migrations';

export class Migration20260827000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN result_balance_amount NUMERIC(19,2) NULL,
        ADD COLUMN result_balance_currency VARCHAR(3) NULL;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_result_balance_both_or_neither CHECK (
          (result_balance_amount IS NULL AND result_balance_currency IS NULL) OR
          (result_balance_amount IS NOT NULL AND result_balance_currency IS NOT NULL)
        ),
        ADD CONSTRAINT wager_transactions_result_balance_non_negative CHECK (
          result_balance_amount IS NULL OR result_balance_amount >= 0
        ),
        ADD CONSTRAINT wager_transactions_result_balance_currency_format CHECK (
          result_balance_currency IS NULL OR result_balance_currency ~ '^[A-Z]{3}$'
        );
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT wager_transactions_result_balance_both_or_neither,
        DROP CONSTRAINT wager_transactions_result_balance_non_negative,
        DROP CONSTRAINT wager_transactions_result_balance_currency_format;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
        DROP COLUMN result_balance_amount,
        DROP COLUMN result_balance_currency;
    `);
  }
}
