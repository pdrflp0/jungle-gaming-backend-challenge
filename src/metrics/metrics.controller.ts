import { Controller, Get, Header } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { selectDlqDepth } from '../observability/dlq-depth';
import {
  metricsRegistry,
  outboxLagSeconds,
  wagerTransactionsByStatus,
  wagerTransactionsDlqMessages,
} from '../observability/metrics';
import { logStructuredWarning } from '../observability/structured-logger';
import { selectOutboxLagSeconds, selectWagerTransactionCountsByStatus } from '../observability/wager-transaction-metrics.sql';

const QUERY_TIMEOUT_MS = 2000;

/**
 * Mesmo idioma do `withTimeout` de health.controller.ts: o `.then`/`.catch`
 * fica preso na promise ORIGINAL (nunca um `Promise.race` que descarta a
 * perdedora) — evita "unhandled rejection" se a consulta rejeitar depois do
 * timeout ja ter vencido.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} metrics query timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `GET /metrics` (CHALLENGE.md secao 12). Publico, sem autenticacao — mesmo
 * tratamento dos endpoints de health (secao 2 do desafio ja isenta health;
 * metrics segue o mesmo raciocinio: nao ha payload financeiro nem dado
 * pessoal aqui, so contagens agregadas).
 *
 * As 3 gauges "de estado atual" (transacoes por status, atraso da outbox,
 * profundidade da DLQ) sao recalculadas a CADA scrape, cada uma com timeout
 * de 2s. Se uma consulta falhar (Postgres ou SQS fora do ar), a gauge
 * correspondente SIMPLESMENTE MANTEM o ultimo valor observado com sucesso —
 * nunca e zerada nem inventada — e um log estruturado sanitizado (so o nome
 * da metrica e o tipo do erro, nunca a mensagem crua que poderia conter host/
 * porta) registra a falha. O endpoint nunca derruba a resposta inteira por
 * causa de uma dependencia fora do ar.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient,
  ) {}

  // O Express injeta "charset=utf-8" automaticamente em qualquer Content-Type
  // text/* sem charset declarado — o header que chega ao cliente vira
  // 'text/plain; charset=utf-8; version=0.0.4', o que e compativel com (e mais
  // explicito que) o formato de exposicao do Prometheus.
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async get(): Promise<string> {
    await Promise.all([this.refreshWagerTransactionsByStatus(), this.refreshOutboxLag(), this.refreshDlqDepth()]);
    return metricsRegistry.metrics();
  }

  private async refreshWagerTransactionsByStatus(): Promise<void> {
    try {
      const rows = await withTimeout(
        selectWagerTransactionCountsByStatus(this.em),
        QUERY_TIMEOUT_MS,
        'wager_transactions_by_status',
      );
      wagerTransactionsByStatus.reset();
      for (const row of rows) {
        wagerTransactionsByStatus.set({ kind: row.kind, status: row.status }, Number(row.count));
      }
    } catch (error) {
      this.logQueryFailure('wager_transactions_by_status', error);
    }
  }

  private async refreshOutboxLag(): Promise<void> {
    try {
      const lagSeconds = await withTimeout(selectOutboxLagSeconds(this.em), QUERY_TIMEOUT_MS, 'outbox_lag_seconds');
      outboxLagSeconds.set(lagSeconds);
    } catch (error) {
      this.logQueryFailure('outbox_lag_seconds', error);
    }
  }

  private async refreshDlqDepth(): Promise<void> {
    try {
      const depth = await withTimeout(
        selectDlqDepth(this.sqsClient),
        QUERY_TIMEOUT_MS,
        'wager_transactions_dlq_messages',
      );
      wagerTransactionsDlqMessages.set({ visibility: 'visible' }, depth.visible);
      wagerTransactionsDlqMessages.set({ visibility: 'in_flight' }, depth.inFlight);
    } catch (error) {
      this.logQueryFailure('wager_transactions_dlq_messages', error);
    }
  }

  private logQueryFailure(metric: string, error: unknown): void {
    logStructuredWarning('metrics_query_failed', {
      metric,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
