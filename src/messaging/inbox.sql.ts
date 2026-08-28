import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Mesma disciplina do restante do projeto (ver wagering/wager-transaction.sql.ts
 * e messaging/outbox.sql.ts): `em.getConnection()` sozinho NAO amarra a query
 * a transacao aberta por em.transactional() — e preciso passar
 * `em.getTransactionContext()` explicitamente.
 */
function execute<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T> {
  return em.getConnection().execute(sql, params, 'all', em.getTransactionContext()) as Promise<T>;
}

export interface InboxMessageRow {
  message_id: string;
  consumer_name: string;
  payload_hash: string;
  received_at: Date;
  processed_at: Date | null;
}

export interface ClaimInboxMessageParams {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

/**
 * Reivindica a mensagem atomicamente via INSERT ... ON CONFLICT DO NOTHING —
 * sem SAVEPOINT nem captura de excecao de unicidade. Se a linha for
 * retornada, ESTA execucao e a dona da mensagem e pode prosseguir com o
 * processamento financeiro. Se nao vier nenhuma linha (`undefined`), alguem
 * ja reivindicou antes (ou esta reivindicando concorrentemente agora) — o
 * chamador precisa reler via `selectInboxMessage` e classificar o caso.
 */
export async function tryClaimInboxMessage(
  em: EntityManager,
  params: ClaimInboxMessageParams,
): Promise<InboxMessageRow | undefined> {
  const rows = await execute<InboxMessageRow[]>(
    em,
    `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (consumer_name, message_id) DO NOTHING
     RETURNING *`,
    [params.messageId, params.consumerName, params.payloadHash, params.receivedAt],
  );
  return rows[0];
}

export async function selectInboxMessage(
  em: EntityManager,
  consumerName: string,
  messageId: string,
): Promise<InboxMessageRow | undefined> {
  const rows = await execute<InboxMessageRow[]>(
    em,
    'SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
    [consumerName, messageId],
  );
  return rows[0];
}

export async function markInboxMessageProcessed(
  em: EntityManager,
  consumerName: string,
  messageId: string,
  processedAt: Date,
): Promise<void> {
  await execute(em, 'UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?', [
    processedAt,
    consumerName,
    messageId,
  ]);
}
