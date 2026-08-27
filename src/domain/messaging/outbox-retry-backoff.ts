/**
 * Backoff exponencial proprio da Outbox — independente do backoff do worker
 * de PENDING_REFERENCE (Bloco 7b, `wagering/retry-worker.config.ts`). Sao
 * dois problemas parecidos na forma mas diferentes na causa (reprocessar uma
 * referencia ausente vs. reprocessar uma publicacao de evento que falhou);
 * decisao vinculante do Bloco 9a foi nao extrair uma abstracao compartilhada
 * so por semelhanca matematica.
 */

export const OUTBOX_RETRY_BASE_DELAY_SECONDS = 5;
export const OUTBOX_RETRY_MAX_DELAY_SECONDS = 300;

/**
 * `attemptNumber` e o numero (1-based) da tentativa de publicacao que acabou
 * de falhar. Dobra a cada tentativa ate o teto: 5s, 10s, 20s, 40s, 80s,
 * 160s, 300s, 300s, ...
 */
export function computeOutboxNextAttemptDelaySeconds(attemptNumber: number): number {
  return Math.min(OUTBOX_RETRY_BASE_DELAY_SECONDS * 2 ** (attemptNumber - 1), OUTBOX_RETRY_MAX_DELAY_SECONDS);
}
