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

/** Linha crua de outbox_messages — usada pelo publisher (Bloco 9c). */
export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

/**
 * Reivindica, com FOR UPDATE SKIP LOCKED, uma linha pendente devida agora —
 * mesmo idioma do `selectDuePendingReferenceForUpdate` (Bloco 7b). Se outra
 * instancia/publisher ja estiver com essa linha travada, o Postgres a pula
 * em vez de esperar, entao dois publishers rodando ao mesmo tempo nunca
 * pegam a mesma linha.
 */
export async function selectDueOutboxMessageForUpdate(em: EntityManager): Promise<OutboxRow | undefined> {
  const rows = await execute<OutboxRow[]>(
    em,
    `SELECT * FROM outbox_messages
     WHERE published_at IS NULL AND next_attempt_at <= now()
     ORDER BY next_attempt_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
  );
  return rows[0];
}

/**
 * Publicacao confirmada: `next_attempt_at` volta a NULL — a constraint
 * `outbox_messages_next_attempt_consistency` (Bloco 9a.1) exige isso.
 */
export async function markOutboxMessagePublished(em: EntityManager, id: string): Promise<void> {
  await execute(em, `UPDATE outbox_messages SET published_at = now(), next_attempt_at = NULL WHERE id = ?`, [id]);
}

/**
 * Tentativa de publicacao falhou (erro de rede, payload invalido, etc.):
 * incrementa `attempts` e reagenda pelo backoff proprio da Outbox
 * (`computeOutboxNextAttemptDelaySeconds`). O instante em si e sempre o do
 * Postgres (`now()`), nunca o relogio da aplicacao — mesmo cuidado do
 * `updateWagerTransactionRetry` (Bloco 7b).
 */
export async function scheduleOutboxMessageRetry(em: EntityManager, id: string, delaySeconds: number): Promise<void> {
  await execute(
    em,
    `UPDATE outbox_messages
     SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => ?)
     WHERE id = ?`,
    [delaySeconds, id],
  );
}
