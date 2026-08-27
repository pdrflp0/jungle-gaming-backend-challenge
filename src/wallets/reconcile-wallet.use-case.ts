import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { logStructuredWarning } from '../observability/structured-logger';
import { walletReconciliationDivergences } from '../observability/metrics';
import { selectWalletReconciliation } from './wallet.sql';

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Reconciliacao e so auditoria: nunca corrige saldo nem ledger, so relata.
 * Toda a soma/subtracao/comparacao de dinheiro acontece dentro da consulta
 * SQL (ver wallet.sql.ts) — aqui so lemos as strings ja calculadas.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationResponse> {
    const row = await selectWalletReconciliation(this.em, walletId);
    if (!row) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const response: ReconciliationResponse = {
      walletId,
      storedBalance: { amount: row.stored_balance, currency: row.currency },
      calculatedBalance: { amount: row.calculated_balance, currency: row.currency },
      difference: { amount: row.difference, currency: row.currency },
      consistent: row.consistent,
      checkedEntries: row.checked_entries,
    };

    if (!response.consistent) {
      walletReconciliationDivergences.inc({ currency: row.currency });

      // Nunca inclui storedBalance/calculatedBalance/difference nem
      // qualquer outro dado financeiro ou pessoal — so o suficiente para
      // localizar e correlacionar o evento.
      logStructuredWarning('wallet_reconciliation_divergence', {
        correlationId,
        walletId,
        currency: row.currency,
        checkedEntries: row.checked_entries,
        consistent: false,
      });
    }

    return response;
  }
}
