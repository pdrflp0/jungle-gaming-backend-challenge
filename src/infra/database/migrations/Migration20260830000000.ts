import { Migration } from '@mikro-orm/migrations';

/**
 * Suporte ao Bloco 9a.2 (registro de eventos na Outbox): toda WagerTransaction
 * passa a carregar o correlationId que originou seu processamento, e — so
 * quando ela entra em PENDING_REFERENCE — o eventId do evento
 * WagerTransactionPendingReference que foi emitido naquele momento, para o
 * worker usar depois como causationId do evento terminal.
 *
 * `correlation_id` vira NOT NULL: linhas pre-existentes (se houver) recebem
 * o proprio id como valor de backfill, documentado como estrategia de
 * migracao — nao como um correlationId real capturado. `pending_reference_event_id`
 * fica NULL para sempre em linhas que nunca passaram por PENDING_REFERENCE
 * (inclusive todas as pre-existentes) — o worker trata NULL como "sem
 * causationId conhecido", nunca como erro.
 */
export class Migration20260830000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN correlation_id VARCHAR NULL;`);
    this.addSql(`UPDATE wager_transactions SET correlation_id = id::text WHERE correlation_id IS NULL;`);
    this.addSql(`ALTER TABLE wager_transactions ALTER COLUMN correlation_id SET NOT NULL;`);

    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN pending_reference_event_id UUID NULL;`);
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN pending_reference_event_id;`);
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN correlation_id;`);
  }
}
