import { Counter, Registry } from 'prom-client';

/**
 * Registry proprio do projeto — nunca o registro global padrao do
 * prom-client. Evita "metric already registered" quando o modulo e
 * recarregado (testes, hot reload) e deixa pronta a fundacao para o futuro
 * `GET /metrics` (bloco de observabilidade): basta expor
 * `metricsRegistry.metrics()` numa rota, sem tocar em nenhum contador
 * existente.
 */
export const metricsRegistry = new Registry();

/** Incrementado uma vez por reconciliacao que encontrar divergencia — nunca no caso consistente. */
export const walletReconciliationDivergences = new Counter({
  name: 'wallet_reconciliation_divergences_total',
  help: 'Reconciliation checks that found a divergence between stored and calculated wallet balance',
  labelNames: ['currency'] as const,
  registers: [metricsRegistry],
});
