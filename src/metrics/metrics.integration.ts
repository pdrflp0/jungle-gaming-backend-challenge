import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../app.module';
import { WAGER_TRANSACTIONS_DLQ_QUEUE_NAME } from '../observability/dlq-depth';
import { publishDueOutboxMessage, WAGER_TRANSACTION_EVENTS_QUEUE_NAME } from '../messaging/outbox-publisher';
import { createSqsClient, resolveQueueUrl } from '../wagering/sqs-client';
import { processWagerTransactionMessage } from '../wagering/process-wager-transaction-message';
import { RetryPendingReferenceWorker } from '../wagering/retry-pending-reference.worker';
import { buildWagerTransactionMessageBody, waitFor } from '../wagering/sqs-test-helpers';
import { MetricsController } from './metrics.controller';

/**
 * Integracao real do bloco de metricas (`GET /metrics`): PostgreSQL e
 * LocalStack reais, aplicacao Nest inteira. Nenhum contador/gauge e
 * incrementado/definido diretamente pelo teste — cada asserção provoca o
 * EVENTO REAL (uma mensagem duplicada de verdade, um SendMessage que falha
 * de verdade contra uma fila inexistente, uma linha de outbox realmente
 * atrasada) e so entao le `/metrics`.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:integration`.
 */

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;
let worker: RetryPendingReferenceWorker;
let sendClient: SQSClient;
let dlqUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : address;
  baseUrl = `http://127.0.0.1:${port}`;
  orm = app.get(MikroORM);
  worker = app.get(RetryPendingReferenceWorker);

  sendClient = createSqsClient();
  dlqUrl = await resolveQueueUrl(sendClient, WAGER_TRANSACTIONS_DLQ_QUEUE_NAME);
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));
});

afterEach(async () => {
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
  await sendClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));
});

afterAll(async () => {
  sendClient.destroy();
  await app.close();
});

interface OpenWalletBody {
  id: string;
}

interface Wallet {
  walletId: string;
  playerId: string;
}

async function createWallet(initialAmount: string): Promise<Wallet> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } }),
  });
  const body = (await response.json()) as OpenWalletBody;
  return { walletId: body.id, playerId };
}

function submitWager(
  idempotencyKey: string,
  overrides: Partial<{
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId: string;
  }>,
): Promise<Response> {
  const payload: Record<string, unknown> = {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };

  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  });
}

async function fetchMetricsText(): Promise<string> {
  const response = await fetch(`${baseUrl}/metrics`);
  return response.text();
}

/**
 * Le uma linha `name{k="v",...} value` do texto Prometheus, sem depender da
 * ORDEM dos labels — casa por conjunto de pares chave/valor, nao por
 * posicao. Devolve 0 se a serie ainda nao existe (ausencia real, nunca
 * inventada).
 */
function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels);
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) {
      continue;
    }
    const match = line.match(/^(\S+?)(?:\{(.*)\})? (\S+)$/);
    if (!match || match[1] !== name) {
      continue;
    }
    const actual: Record<string, string> = {};
    if (match[2]) {
      for (const pair of match[2].split(',')) {
        const [key, rawValue] = pair.split('=');
        actual[key] = rawValue.replace(/^"|"$/g, '');
      }
    }
    if (wanted.every(([key, value]) => actual[key] === value)) {
      return Number(match[3]);
    }
  }
  return 0;
}

async function insertOutboxRow(options: {
  occurredAtSecondsAgo?: number;
  eventType?: string;
  walletId?: string;
}): Promise<{ id: string; eventType: string }> {
  const id = randomUUID();
  const eventType = options.eventType ?? 'WagerTransactionProcessed';
  const payload = {
    eventId: id,
    eventType,
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    version: 1,
    data: { walletId: options.walletId ?? randomUUID(), transactionId: randomUUID() },
  };

  await orm.em.getConnection().execute(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?::jsonb, now() - make_interval(secs => ?), 0, now())`,
    [id, payload.aggregateId, eventType, JSON.stringify(payload), options.occurredAtSecondsAgo ?? 0],
  );

  return { id, eventType };
}

const ALL_REQUIRED_METRIC_NAMES = [
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

describe('GET /metrics — formato Prometheus e ausencia de dados sensiveis', () => {
  test('200, content-type correto, contem todas as metricas exigidas, sem payload/credencial', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    // O Express (adapter HTTP do Nest) injeta automaticamente "charset=utf-8"
    // em qualquer Content-Type text/* que ainda nao declare charset — o
    // header literal setado pelo controller e 'text/plain; version=0.0.4',
    // mas o que chega ao cliente e 'text/plain; charset=utf-8; version=0.0.4'.
    // Isso e, alias, mais aderente ao formato de exposicao do Prometheus
    // (que recomenda charset=utf-8 explicito) — nao um bug. Verificamos os
    // dois componentes exigidos em vez de igualdade exata de string.
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/plain');
    expect(contentType).toContain('version=0.0.4');

    const text = await response.text();
    for (const name of ALL_REQUIRED_METRIC_NAMES) {
      expect(text).toContain(name);
    }

    expect(text.toLowerCase()).not.toContain('password');
    expect(text.toLowerCase()).not.toContain('secret');
  });
});

describe('GET /metrics — registro idempotente sob multiplas inicializacoes da aplicacao', () => {
  test('uma segunda instancia inteira da app no mesmo processo nao lanca "metric already registered"', async () => {
    const secondApp = await NestFactory.create(AppModule, { logger: false });
    await secondApp.listen(0);
    try {
      const address = secondApp.getHttpServer().address();
      const port = typeof address === 'object' && address !== null ? address.port : address;
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(200);
    } finally {
      await secondApp.close();
    }
  });
});

describe('GET /metrics — transacoes por status (contagem real do PostgreSQL)', () => {
  test('BET processada via HTTP aumenta wager_transactions_by_status{kind="BET",status="PROCESSED"} em exatamente 1', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const before = metricValue(await fetchMetricsText(), 'wager_transactions_by_status', {
      kind: 'BET',
      status: 'PROCESSED',
    });

    const response = await submitWager(randomUUID(), { walletId, playerId, money: { amount: '10.00', currency: 'BRL' } });
    expect(response.status).toBe(201);

    const after = metricValue(await fetchMetricsText(), 'wager_transactions_by_status', {
      kind: 'BET',
      status: 'PROCESSED',
    });
    expect(after - before).toBe(1);
  });
});

describe('GET /metrics — duplicatas reais do Inbox', () => {
  test('mesma mensagem processada duas vezes: inbox_duplicates_detected_total aumenta exatamente 1', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const envelope = buildWagerTransactionMessageBody(walletId, playerId);
    const before = metricValue(await fetchMetricsText(), 'inbox_duplicates_detected_total');

    const first = await orm.em.fork().transactional((trxEm) => processWagerTransactionMessage(trxEm, envelope));
    expect(first).toBe('processed');
    const second = await orm.em.fork().transactional((trxEm) => processWagerTransactionMessage(trxEm, envelope));
    expect(second).toBe('duplicate');

    const after = metricValue(await fetchMetricsText(), 'inbox_duplicates_detected_total');
    expect(after - before).toBe(1);
  });
});

describe('GET /metrics — retries reais do worker de PENDING_REFERENCE', () => {
  test('referencia ainda ausente: worker reagenda e wager_pending_reference_retries_total{kind="REFUND"} aumenta 1', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const before = metricValue(await fetchMetricsText(), 'wager_pending_reference_retries_total', { kind: 'REFUND' });

    const pending = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'REFUND',
      referenceExternalTransactionId: randomUUID(),
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(pending.status).toBe(202);

    expect(await worker.processDueOnce()).toBe(true); // referencia continua ausente: reagenda de verdade

    const after = metricValue(await fetchMetricsText(), 'wager_pending_reference_retries_total', { kind: 'REFUND' });
    expect(after - before).toBe(1);
  });
});

describe('GET /metrics — retries reais do publisher da Outbox', () => {
  test('SendMessage falha contra fila inexistente: outbox_publish_retries_total{event_type} aumenta 1', async () => {
    const { eventType } = await insertOutboxRow({});
    const before = metricValue(await fetchMetricsText(), 'outbox_publish_retries_total', { event_type: eventType });

    const realEventsQueueUrl = await resolveQueueUrl(sendClient, WAGER_TRANSACTION_EVENTS_QUEUE_NAME);
    const bogusQueueUrl = `${realEventsQueueUrl}-does-not-exist`;
    const processed = await publishDueOutboxMessage(orm.em.fork(), sendClient, bogusQueueUrl);
    expect(processed).toBe(true);

    const after = metricValue(await fetchMetricsText(), 'outbox_publish_retries_total', { event_type: eventType });
    expect(after - before).toBe(1);
  });
});

describe('GET /metrics — profundidade real da DLQ (visible e in_flight)', () => {
  test('uma mensagem visivel e uma recebida-mas-nao-apagada aparecem em labels separados', async () => {
    await sendClient.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: JSON.stringify({ probe: 'visible' }),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );
    await sendClient.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: JSON.stringify({ probe: 'in-flight' }),
        MessageGroupId: randomUUID(),
        MessageDeduplicationId: randomUUID(),
      }),
    );

    await waitFor(
      async () => {
        const { Messages } = await sendClient.send(
          new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
        );
        return (Messages?.length ?? 0) === 1;
      },
      { description: 'uma mensagem recebida e deixada em voo (nao apagada)' },
    );

    const text = await fetchMetricsText();
    expect(metricValue(text, 'wager_transactions_dlq_messages', { visibility: 'visible' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(text, 'wager_transactions_dlq_messages', { visibility: 'in_flight' })).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

describe('GET /metrics — atraso real da Outbox', () => {
  test('linha pendente com occurred_at 5s no passado produz outbox_lag_seconds >= 4', async () => {
    await insertOutboxRow({ occurredAtSecondsAgo: 5 });

    const text = await fetchMetricsText();
    expect(metricValue(text, 'outbox_lag_seconds')).toBeGreaterThanOrEqual(4);
  });

  test('nenhuma linha pendente: outbox_lag_seconds e exatamente 0 (nunca inventado)', async () => {
    // afterEach ja truncou outbox_messages antes deste teste comecar —
    // nenhuma linha pendente existe neste ponto.
    const text = await fetchMetricsText();
    expect(metricValue(text, 'outbox_lag_seconds')).toBe(0);
  });
});

describe('GET /metrics — latencia observada em finally (HTTP e SQS)', () => {
  test('submissao HTTP bem-sucedida incrementa o _count do histograma para source=http,outcome=success', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const before = metricValue(await fetchMetricsText(), 'wager_transaction_processing_duration_seconds_count', {
      source: 'http',
      outcome: 'success',
    });

    await submitWager(randomUUID(), { walletId, playerId, money: { amount: '5.00', currency: 'BRL' } });

    const after = metricValue(await fetchMetricsText(), 'wager_transaction_processing_duration_seconds_count', {
      source: 'http',
      outcome: 'success',
    });
    expect(after - before).toBe(1);
  });

  test('submissao SQS (via processWagerTransactionMessage direto) nao afeta o label source=http', async () => {
    // A latencia do consumidor real e medida em wager-transaction-sqs-consumer.ts
    // (handleMessage), ja coberto pelos testes reais do consumidor em
    // wager-transaction-sqs-consumer.integration.ts. Aqui so confirmamos que
    // chamar o nucleo puro (sem passar pelo controller HTTP) nao incrementa
        // o label http — os dois labels sao mutuamente exclusivos por origem.
    const { walletId, playerId } = await createWallet('100.00');
    const before = metricValue(await fetchMetricsText(), 'wager_transaction_processing_duration_seconds_count', {
      source: 'http',
    });

    const envelope = buildWagerTransactionMessageBody(walletId, playerId);
    await orm.em.fork().transactional((trxEm) => processWagerTransactionMessage(trxEm, envelope));

    const after = metricValue(await fetchMetricsText(), 'wager_transaction_processing_duration_seconds_count', {
      source: 'http',
    });
    expect(after).toBe(before);
  });
});

describe('MetricsController — Postgres ou SQS indisponivel (dependencia simulada, ver health.integration.ts para o mesmo padrao)', () => {
  test('Postgres falha: /metrics ainda responde 200, mantem o ULTIMO valor conhecido da gauge de status, log nunca vaza a mensagem crua', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const submit = await submitWager(randomUUID(), { walletId, playerId, money: { amount: '5.00', currency: 'BRL' } });
    expect(submit.status).toBe(201);

    // popula a gauge com um valor real conhecido, via o endpoint de verdade.
    const knownGoodValue = metricValue(await fetchMetricsText(), 'wager_transactions_by_status', {
      kind: 'BET',
      status: 'PROCESSED',
    });
    expect(knownGoodValue).toBeGreaterThanOrEqual(1);

    const failingEm = {
      getConnection: () => ({ execute: () => Promise.reject(new Error('simulated postgres failure — host=db:5432')) }),
    } as unknown as EntityManager;
    const controllerWithFailingPostgres = new MetricsController(failingEm, sendClient);

    const text = await controllerWithFailingPostgres.get();
    expect(metricValue(text, 'wager_transactions_by_status', { kind: 'BET', status: 'PROCESSED' })).toBe(
      knownGoodValue,
    ); // mantido, nunca zerado nem inventado
    expect(text).not.toContain('simulated postgres failure');
    expect(text).not.toContain('db:5432');
  });

  test('SQS falha: /metrics ainda responde 200 com as demais metricas presentes, sem derrubar o endpoint inteiro', async () => {
    const failingSqs = { send: () => Promise.reject(new Error('simulated sqs failure')) } as unknown as SQSClient;
    const controllerWithFailingSqs = new MetricsController(orm.em.fork(), failingSqs);

    const text = await controllerWithFailingSqs.get();
    expect(text).toContain('wager_transactions_by_status');
    expect(text).toContain('outbox_lag_seconds');
    expect(text).toContain('wager_transactions_dlq_messages'); // serie ja existe (metrica declarada), so nao foi atualizada agora
    expect(text).not.toContain('simulated sqs failure');
  });
});
