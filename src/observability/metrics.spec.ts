import { describe, expect, test } from 'bun:test';
import { register } from 'prom-client';
import {
  inboxDuplicatesDetectedTotal,
  metricsRegistry,
  outboxLagSeconds,
  outboxPublishRetriesTotal,
  pendingReferenceRetriesTotal,
  wagerLockConflictsTotal,
  wagerTransactionProcessingDurationSeconds,
  wagerTransactionsByStatus,
  wagerTransactionsDlqMessages,
  walletReconciliationDivergences,
} from './metrics';

const ALL_METRIC_NAMES = [
  'wallet_reconciliation_divergences_total',
  'wager_transactions_by_status',
  'outbox_lag_seconds',
  'wager_transactions_dlq_messages',
  'inbox_duplicates_detected_total',
  'wager_pending_reference_retries_total',
  'outbox_publish_retries_total',
  'wager_lock_conflicts_total',
  'wager_transaction_processing_duration_seconds',
];

async function metricValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric(name)?.get();
  const entries = Object.entries(labels);
  const found = metric?.values.find((v) => entries.every(([key, value]) => v.labels[key] === value));
  return found?.value ?? 0;
}

describe('metrics registry', () => {
  test('walletReconciliationDivergences incrementa por label de currency, isolado do registro global do prom-client', async () => {
    const before = await metricValue('wallet_reconciliation_divergences_total', { currency: 'BRL' });
    walletReconciliationDivergences.inc({ currency: 'BRL' });
    const after = await metricValue('wallet_reconciliation_divergences_total', { currency: 'BRL' });
    expect(after - before).toBe(1);
  });

  test('nenhuma metrica do projeto e registrada no registro global padrao do prom-client', () => {
    for (const name of ALL_METRIC_NAMES) {
      expect(register.getSingleMetric(name)).toBeUndefined();
    }
  });

  test('registro idempotente: cada nome existe exatamente uma vez no registry proprio, mesmo apos multiplas leituras', async () => {
    // Simula o que acontece quando varios arquivos de teste de integracao
    // fazem `NestFactory.create(AppModule)` no mesmo processo: o modulo
    // metrics.ts so e avaliado uma vez (cache de modulo do Bun/Node), entao
    // getSingleMetric nunca "some" nem duplica entre chamadas repetidas.
    for (const name of ALL_METRIC_NAMES) {
      const first = metricsRegistry.getSingleMetric(name);
      const second = metricsRegistry.getSingleMetric(name);
      expect(first).toBeDefined();
      expect(first).toBe(second); // mesma instancia, nunca uma segunda registrada
    }
  });

  test('wagerTransactionsByStatus: gauge aceita set por kind+status e reset limpa combinacoes antigas', async () => {
    wagerTransactionsByStatus.set({ kind: 'BET', status: 'PROCESSED' }, 3);
    expect(await metricValue('wager_transactions_by_status', { kind: 'BET', status: 'PROCESSED' })).toBe(3);

    wagerTransactionsByStatus.reset();
    expect(await metricValue('wager_transactions_by_status', { kind: 'BET', status: 'PROCESSED' })).toBe(0);
  });

  test('outboxLagSeconds: gauge aceita valor real, zero e valor valido (nunca inventado)', async () => {
    outboxLagSeconds.set(0);
    expect(await metricValue('outbox_lag_seconds')).toBe(0);

    outboxLagSeconds.set(12.5);
    expect(await metricValue('outbox_lag_seconds')).toBe(12.5);
  });

  test('wagerTransactionsDlqMessages: gauge distingue visible de in_flight', async () => {
    wagerTransactionsDlqMessages.set({ visibility: 'visible' }, 2);
    wagerTransactionsDlqMessages.set({ visibility: 'in_flight' }, 1);
    expect(await metricValue('wager_transactions_dlq_messages', { visibility: 'visible' })).toBe(2);
    expect(await metricValue('wager_transactions_dlq_messages', { visibility: 'in_flight' })).toBe(1);
  });

  test('inboxDuplicatesDetectedTotal incrementa sem labels', async () => {
    const before = await metricValue('inbox_duplicates_detected_total');
    inboxDuplicatesDetectedTotal.inc();
    expect(await metricValue('inbox_duplicates_detected_total')).toBe(before + 1);
  });

  test('pendingReferenceRetriesTotal incrementa por kind', async () => {
    const before = await metricValue('wager_pending_reference_retries_total', { kind: 'REFUND' });
    pendingReferenceRetriesTotal.inc({ kind: 'REFUND' });
    expect(await metricValue('wager_pending_reference_retries_total', { kind: 'REFUND' })).toBe(before + 1);
  });

  test('outboxPublishRetriesTotal incrementa por event_type', async () => {
    const before = await metricValue('outbox_publish_retries_total', { event_type: 'WagerTransactionProcessed' });
    outboxPublishRetriesTotal.inc({ event_type: 'WagerTransactionProcessed' });
    expect(await metricValue('outbox_publish_retries_total', { event_type: 'WagerTransactionProcessed' })).toBe(
      before + 1,
    );
  });

  test('wagerLockConflictsTotal incrementa por type (deadlock/lock_timeout)', async () => {
    const before = await metricValue('wager_lock_conflicts_total', { type: 'deadlock' });
    wagerLockConflictsTotal.inc({ type: 'deadlock' });
    expect(await metricValue('wager_lock_conflicts_total', { type: 'deadlock' })).toBe(before + 1);
  });

  test('wagerTransactionProcessingDurationSeconds: startTimer/stop registra uma observacao por source+outcome', async () => {
    function countValue(values: { value: number; labels: Record<string, unknown>; metricName?: string }[]): number {
      return values.find((v) => v.metricName?.endsWith('_count') && v.labels.source === 'http' && v.labels.outcome === 'success')
        ?.value ?? 0;
    }

    const beforeMetric = await metricsRegistry.getSingleMetric('wager_transaction_processing_duration_seconds')?.get();
    const beforeCount = beforeMetric ? countValue(beforeMetric.values as unknown as { value: number; labels: Record<string, unknown>; metricName?: string }[]) : 0;

    const stop = wagerTransactionProcessingDurationSeconds.startTimer({ source: 'http' });
    stop({ outcome: 'success' });

    const afterMetric = await metricsRegistry.getSingleMetric('wager_transaction_processing_duration_seconds')?.get();
    const afterCount = afterMetric ? countValue(afterMetric.values as unknown as { value: number; labels: Record<string, unknown>; metricName?: string }[]) : 0;

    expect(afterCount).toBe(beforeCount + 1);
  });
});
