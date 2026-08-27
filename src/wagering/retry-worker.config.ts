/**
 * Parametros do worker de reprocessamento de PENDING_REFERENCE (Bloco 7b).
 * Aprovados em bloco: backoff 5s -> 300s, TTL 30min, tick a cada 3s, lote
 * maximo de 25 transacoes por tick.
 */

export const PENDING_REFERENCE_BASE_DELAY_SECONDS = 5;
export const PENDING_REFERENCE_MAX_DELAY_SECONDS = 300;
export const PENDING_REFERENCE_TTL_MINUTES = 30;
export const PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS = 3000;
export const PENDING_REFERENCE_WORKER_MAX_BATCH_SIZE = 25;

/**
 * `attemptNumber` e o numero (1-based) da tentativa do worker que acabou de
 * falhar em resolver a referencia. O atraso dobra a cada tentativa ate o
 * teto: 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s, ...
 */
export function computeNextAttemptDelaySeconds(attemptNumber: number): number {
  return Math.min(PENDING_REFERENCE_BASE_DELAY_SECONDS * 2 ** (attemptNumber - 1), PENDING_REFERENCE_MAX_DELAY_SECONDS);
}
