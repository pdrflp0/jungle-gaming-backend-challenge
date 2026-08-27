import { describe, expect, test } from 'bun:test';
import { register } from 'prom-client';
import { metricsRegistry, walletReconciliationDivergences } from './metrics';

describe('metrics registry', () => {
  test('walletReconciliationDivergences incrementa por label de currency, isolado do registro global do prom-client', async () => {
    const before = (await metricsRegistry.getSingleMetric('wallet_reconciliation_divergences_total')?.get())
      ?.values.find((v) => v.labels.currency === 'BRL')?.value ?? 0;

    walletReconciliationDivergences.inc({ currency: 'BRL' });

    const after = (await metricsRegistry.getSingleMetric('wallet_reconciliation_divergences_total')?.get())
      ?.values.find((v) => v.labels.currency === 'BRL')?.value ?? 0;

    expect(after - before).toBe(1);

    // nunca registrado no registro global padrao do prom-client — evita
    // "metric already registered" e conflitos com outras dependencias.
    expect(register.getSingleMetric('wallet_reconciliation_divergences_total')).toBeUndefined();
  });
});
