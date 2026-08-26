import { Migration } from '@mikro-orm/migrations';

/**
 * Corrige um problema descoberto ao implementar o processamento real de BET:
 * a FK composta (wallet_id, currency) em wager_transactions impedia que uma
 * transacao com moeda divergente da wallet fosse sequer inserida como
 * PENDING — mas rejeitar graciosamente uma moeda divergente (com
 * failureCode CURRENCY_MISMATCH, ver secao 7 do CHALLENGE.md) exige gravar
 * a transacao com a moeda realmente submetida, que por definicao diverge da
 * wallet nesse caso.
 *
 * O ledger continua com a FK composta original: um lancamento real de
 * dinheiro sempre tem que bater com a moeda da wallet — essa garantia nao
 * muda, so a de wager_transactions relaxa para uma FK simples de existencia.
 */
export class Migration20260827010000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_wallet_currency_fk;
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_wallet_fk FOREIGN KEY (wallet_id) REFERENCES wallets (id);
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_wallet_fk;
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_wallet_currency_fk
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency);
    `);
  }
}
