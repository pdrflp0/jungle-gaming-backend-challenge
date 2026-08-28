import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Registry proprio do projeto — nunca o registro global padrao do
 * prom-client. Evita "metric already registered" quando o modulo e
 * recarregado (testes, hot reload) e deixa pronta a fundacao para o
 * `GET /metrics` (bloco de observabilidade): basta expor
 * `metricsRegistry.metrics()` numa rota, sem tocar em nenhum contador
 * existente.
 *
 * Todo metrico abaixo e definido uma unica vez, no carregamento deste
 * modulo (nunca dentro de um construtor de controller/servico) — e o que
 * garante registro idempotente mesmo quando testes de integracao diferentes
 * fazem `NestFactory.create(AppModule)` varias vezes no mesmo processo: o
 * modulo so e avaliado uma vez, o cache do Node/Bun devolve sempre a mesma
 * instancia de cada metrica.
 */
export const metricsRegistry = new Registry();

/** Incrementado uma vez por reconciliacao que encontrar divergencia — nunca no caso consistente. */
export const walletReconciliationDivergences = new Counter({
  name: 'wallet_reconciliation_divergences_total',
  help: 'Reconciliation checks that found a divergence between stored and calculated wallet balance',
  labelNames: ['currency'] as const,
  registers: [metricsRegistry],
});

/**
 * Contagem atual de wager_transactions por kind+status — recalculada a cada
 * scrape de `/metrics` (ver MetricsController), nunca incrementada
 * manualmente. `kind` e `status` sao colunas VARCHAR com CHECK constraint de
 * valores fixos (ver migration 20260826120000) — cardinalidade finita e
 * pequena, seguro como label.
 */
export const wagerTransactionsByStatus = new Gauge({
  name: 'wager_transactions_by_status',
  help: 'Current count of wager_transactions rows grouped by kind and status (recomputed at scrape time)',
  labelNames: ['kind', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Idade, em segundos, da mensagem pendente mais antiga da Outbox
 * (`published_at IS NULL`) — 0 quando nao ha nenhuma pendente. Recalculada a
 * cada scrape, usando `CURRENT_TIMESTAMP` do proprio Postgres (nunca o
 * relogio da aplicacao).
 */
export const outboxLagSeconds = new Gauge({
  name: 'outbox_lag_seconds',
  help: 'Age in seconds of the oldest unpublished outbox message (0 when none pending)',
  registers: [metricsRegistry],
});

/**
 * Profundidade real da DLQ (`wager-transactions-dlq.fifo`), via
 * GetQueueAttributes — nunca um contador da aplicacao (a app nunca escreve
 * na DLQ, quem move mensagens para la e o proprio SQS via RedrivePolicy).
 * `visibility` tem exatamente 2 valores possiveis: 'visible' (disponivel
 * para consumo) e 'in_flight' (recebida por algum consumidor, ainda dentro
 * do visibility timeout).
 */
export const wagerTransactionsDlqMessages = new Gauge({
  name: 'wager_transactions_dlq_messages',
  help: 'Approximate number of messages currently in wager-transactions-dlq.fifo',
  labelNames: ['visibility'] as const,
  registers: [metricsRegistry],
});

/** Incrementado somente quando processWagerTransactionMessage classifica uma mensagem como 'duplicate' (Inbox). */
export const inboxDuplicatesDetectedTotal = new Counter({
  name: 'inbox_duplicates_detected_total',
  help: 'Number of SQS messages classified as a safe duplicate by the wager-transactions Inbox',
  registers: [metricsRegistry],
});

/** Incrementado somente quando o worker de PENDING_REFERENCE reagenda uma transacao ainda sem referencia resolvida. */
export const pendingReferenceRetriesTotal = new Counter({
  name: 'wager_pending_reference_retries_total',
  help: 'Number of times the PENDING_REFERENCE worker rescheduled a transaction still waiting for its reference',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

/** Incrementado somente quando o publisher da Outbox falha e reagenda (scheduleOutboxMessageRetry). */
export const outboxPublishRetriesTotal = new Counter({
  name: 'outbox_publish_retries_total',
  help: 'Number of times the outbox publisher rescheduled a message after a failed publish attempt',
  labelNames: ['event_type'] as const,
  registers: [metricsRegistry],
});

/** Incrementado somente nos catches reais de DeadlockException/LockWaitTimeoutException do submit de wager transaction. */
export const wagerLockConflictsTotal = new Counter({
  name: 'wager_lock_conflicts_total',
  help: 'Number of deadlock or lock-wait-timeout errors surfaced while submitting a wager transaction',
  labelNames: ['type'] as const,
  registers: [metricsRegistry],
});

/**
 * Latencia de processamento de uma submissao de wager transaction, medida em
 * `finally` (sempre observada, sucesso ou erro) tanto no controller HTTP
 * quanto no consumidor SQS. `source` e `outcome` sao os dois unicos labels —
 * nunca um id de transacao/wallet/mensagem.
 */
export const wagerTransactionProcessingDurationSeconds = new Histogram({
  name: 'wager_transaction_processing_duration_seconds',
  help: 'Time spent processing a wager transaction submission, from either HTTP or the SQS consumer',
  labelNames: ['source', 'outcome'] as const,
  registers: [metricsRegistry],
});
