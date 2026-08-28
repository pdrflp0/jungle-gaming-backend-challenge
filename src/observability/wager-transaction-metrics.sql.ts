import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Consultas somente-leitura para o bloco de metricas (`GET /metrics`).
 * Nenhuma delas escreve nada nem participa de qualquer transacao financeira
 * — sao chamadas isoladamente a cada scrape, fora do `em.transactional()` de
 * qualquer fluxo de negocio.
 */
function execute<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T> {
  return em.getConnection().execute(sql, params) as Promise<T>;
}

export interface WagerTransactionStatusCount {
  kind: string;
  status: string;
  count: string;
}

/** Uma linha por combinacao (kind, status) atualmente existente — nunca inventa uma combinacao com contagem zero. */
export async function selectWagerTransactionCountsByStatus(
  em: EntityManager,
): Promise<WagerTransactionStatusCount[]> {
  return execute<WagerTransactionStatusCount[]>(
    em,
    `SELECT kind, status, count(*)::text AS count FROM wager_transactions GROUP BY kind, status`,
  );
}

/**
 * Segundos desde `occurred_at` da mensagem de outbox pendente mais antiga
 * (`published_at IS NULL`), usando `CURRENT_TIMESTAMP` do proprio Postgres —
 * nunca o relogio da aplicacao (mesmo cuidado de `updateWagerTransactionRetry`
 * / `scheduleOutboxMessageRetry`). Retorna 0 quando nao ha nenhuma pendente —
 * valor real (ausencia de atraso), nunca um numero inventado.
 */
export async function selectOutboxLagSeconds(em: EntityManager): Promise<number> {
  const rows = await execute<{ lag_seconds: string | number | null }[]>(
    em,
    `SELECT extract(epoch FROM CURRENT_TIMESTAMP - occurred_at) AS lag_seconds
     FROM outbox_messages
     WHERE published_at IS NULL
     ORDER BY occurred_at
     LIMIT 1`,
  );
  const row = rows[0];
  if (!row || row.lag_seconds === null) {
    return 0;
  }
  return Number(row.lag_seconds);
}
