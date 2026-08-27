import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/messaging/outbox-message';

/**
 * Mesma disciplina do restante do projeto (ver wagering/wager-transaction.sql.ts):
 * `em.getConnection()` sozinho NAO amarra a query a transacao aberta por
 * em.transactional() — e preciso passar `em.getTransactionContext()`
 * explicitamente, senao o Postgres roda a instrucao em autocommit, fora da
 * transacao financeira em andamento.
 */
function execute<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T> {
  return em.getConnection().execute(sql, params, 'all', em.getTransactionContext()) as Promise<T>;
}

/**
 * Registra a INTENCAO de publicar um evento — nunca publica nada. Chamado
 * dentro da MESMA transacao SQL da mudanca financeira (Bloco 9a.2).
 */
export async function insertOutboxMessage(em: EntityManager, message: OutboxMessage): Promise<void> {
  await execute(
    em,
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`,
    [
      message.id,
      message.aggregateId,
      message.eventType,
      JSON.stringify(message.payload),
      message.occurredAt,
      message.attempts,
      message.nextAttemptAt ?? null,
    ],
  );
}
