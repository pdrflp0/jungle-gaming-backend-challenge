import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../app.module';
import { FailureCode, WagerTransactionKind } from '../domain/wagering/wager-transaction';
import { RetryPendingReferenceWorker } from '../wagering/retry-pending-reference.worker';
import { SubmitWagerTransactionUseCase } from '../wagering/submit-wager-transaction.use-case';
import type { SubmitWagerTransactionDto } from '../wagering/dto/submit-wager-transaction.dto';

/**
 * Integracao real do Bloco 9a.2: registro atomico dos eventos na Outbox,
 * correlationId/causationId, replay, atomicidade e savepoint. Sobe a
 * aplicacao Nest inteira e chama os endpoints HTTP via fetch, exatamente
 * como wagering.integration.ts.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:integration`.
 */

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;
let worker: RetryPendingReferenceWorker;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : address;
  baseUrl = `http://127.0.0.1:${port}`;
  orm = app.get(MikroORM);
  worker = app.get(RetryPendingReferenceWorker);
});

afterEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE outbox_messages, wallet_ledger_entries, wager_transactions, wallets');
});

afterAll(async () => {
  await app.close();
});

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: Record<string, unknown>;
  };
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

interface WagerTransactionRowShape {
  id: string;
  correlation_id: string;
  pending_reference_event_id: string | null;
  next_attempt_at: Date | null;
  created_at: Date;
}

async function outboxRowsFor(aggregateId: string): Promise<OutboxRow[]> {
  return orm.em
    .getConnection()
    .execute<OutboxRow[]>('SELECT * FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id', [
      aggregateId,
    ]);
}

/**
 * WalletBalanceChanged usa o WALLET como aggregateId (nao a transacao) — um
 * wallet acumula um evento desses por movimentacao ao longo de varias
 * transacoes. Para isolar "o BalanceChanged desta transacao especifica",
 * filtra pelo `data.transactionId` dentro do payload.
 */
async function balanceChangedEventsFor(walletId: string, transactionId: string): Promise<OutboxRow[]> {
  const rows = await outboxRowsFor(walletId);
  return rows.filter((row) => row.event_type === 'WalletBalanceChanged' && row.payload.data.transactionId === transactionId);
}

async function outboxCountTotal(): Promise<number> {
  const rows = await orm.em.getConnection().execute<{ count: number }[]>('SELECT count(*)::int AS count FROM outbox_messages');
  return rows[0].count;
}

async function wagerTransactionRow(
  providerId: string,
  externalTransactionId: string,
): Promise<WagerTransactionRowShape> {
  const rows = await orm.em
    .getConnection()
    .execute<WagerTransactionRowShape[]>(
      'SELECT id, correlation_id, pending_reference_event_id, next_attempt_at, created_at FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
      [providerId, externalTransactionId],
    );
  return rows[0];
}

async function openingTransactionId(walletId: string): Promise<string> {
  const rows = await orm.em
    .getConnection()
    .execute<{ id: string }[]>("SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'", [
      walletId,
    ]);
  return rows[0].id;
}

async function forceDueNow(transactionId: string): Promise<void> {
  await orm.em
    .getConnection()
    .execute('UPDATE wager_transactions SET next_attempt_at = now() WHERE id = ?', [transactionId]);
}

async function backdateCreatedAt(transactionId: string, minutesAgo: number): Promise<void> {
  await orm.em
    .getConnection()
    .execute("UPDATE wager_transactions SET created_at = now() - make_interval(mins => ?) WHERE id = ?", [
      minutesAgo,
      transactionId,
    ]);
}

interface OpenWalletBody {
  id: string;
}

interface SubmitBody {
  transactionId: string;
  status: string;
  balance?: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

async function createWallet(
  initialAmount: string,
  correlationIdHeader?: string,
): Promise<{ walletId: string; playerId: string; correlationId: string }> {
  const playerId = randomUUID();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (correlationIdHeader !== undefined) {
    headers['x-correlation-id'] = correlationIdHeader;
  }
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } }),
  });
  const body = (await response.json()) as OpenWalletBody;
  const correlationId = response.headers.get('x-correlation-id') as string;
  return { walletId: body.id, playerId, correlationId };
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
  correlationIdHeader?: string,
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

  const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': idempotencyKey };
  if (correlationIdHeader !== undefined) {
    headers['x-correlation-id'] = correlationIdHeader;
  }

  return fetch(`${baseUrl}/wagering/transactions`, { method: 'POST', headers, body: JSON.stringify(payload) });
}

describe('Outbox — OPENING (Bloco 9a.2)', () => {
  test('saldo inicial positivo gera Processed + BalanceChanged, mesmo correlationId nos dois', async () => {
    const { walletId, correlationId } = await createWallet('1000.00', 'req-opening-positive');
    expect(correlationId).toBe('req-opening-positive');

    const txId = await openingTransactionId(walletId);
    const processedRows = await outboxRowsFor(txId);
    const balanceChangedRows = await outboxRowsFor(walletId);

    expect(processedRows).toHaveLength(1);
    expect(processedRows[0].event_type).toBe('WagerTransactionProcessed');
    expect(processedRows[0].payload.correlationId).toBe('req-opening-positive');
    expect(processedRows[0].payload.causationId).toBeUndefined();

    expect(balanceChangedRows).toHaveLength(1);
    expect(balanceChangedRows[0].event_type).toBe('WalletBalanceChanged');
    expect(balanceChangedRows[0].payload.correlationId).toBe('req-opening-positive');
    expect(balanceChangedRows[0].payload.data.walletVersion).toBe(1);
  });

  test('saldo inicial zero nao gera nenhum evento', async () => {
    const before = await outboxCountTotal();
    const { walletId } = await createWallet('0.00');
    const after = await outboxCountTotal();

    expect(after).toBe(before);
    const rows = await outboxRowsFor(walletId);
    expect(rows).toHaveLength(0);
  });
});

describe('Outbox — transacoes aplicadas com sucesso (Bloco 9a.2)', () => {
  test('BET aplicado gera Processed + BalanceChanged', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();

    const response = await submitWager(randomUUID(), { walletId, playerId, externalTransactionId }, 'req-bet');
    expect(response.status).toBe(201);

    const row = await wagerTransactionRow('provider-a', externalTransactionId);
    const txEvents = await outboxRowsFor(row.id);
    expect(txEvents.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed']);
    expect(txEvents[0].payload.correlationId).toBe('req-bet');
    expect(txEvents[0].payload.data.kind).toBe(WagerTransactionKind.Bet);

    const balanceEvents = await balanceChangedEventsFor(walletId, row.id);
    expect(balanceEvents).toHaveLength(1);
    expect(balanceEvents[0].payload.correlationId).toBe('req-bet');
  });

  test('WIN aplicado (referenciando a BET) gera Processed + BalanceChanged', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    await submitWager(randomUUID(), { walletId, playerId, externalTransactionId: betExternalId, kind: 'BET' });

    const winExternalId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: winExternalId,
      kind: 'WIN',
      money: { amount: '15.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    expect(response.status).toBe(201);

    const row = await wagerTransactionRow('provider-a', winExternalId);
    const txEvents = await outboxRowsFor(row.id);
    expect(txEvents.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed']);
    const balanceEvents = await balanceChangedEventsFor(walletId, row.id);
    expect(balanceEvents).toHaveLength(1);
  });

  test('REFUND aplicado (referenciando a BET) gera Processed + BalanceChanged', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    await submitWager(randomUUID(), { walletId, playerId, externalTransactionId: betExternalId, kind: 'BET' });

    const refundExternalId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: refundExternalId,
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    expect(response.status).toBe(201);

    const row = await wagerTransactionRow('provider-a', refundExternalId);
    const txEvents = await outboxRowsFor(row.id);
    expect(txEvents.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed']);
    const balanceEvents = await balanceChangedEventsFor(walletId, row.id);
    expect(balanceEvents).toHaveLength(1);
  });

  test('ROLLBACK aplicado (revertendo a BET) gera Processed + BalanceChanged', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    await submitWager(randomUUID(), { walletId, playerId, externalTransactionId: betExternalId, kind: 'BET' });

    const rollbackExternalId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: rollbackExternalId,
      kind: 'ROLLBACK',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    expect(response.status).toBe(201);

    const row = await wagerTransactionRow('provider-a', rollbackExternalId);
    const txEvents = await outboxRowsFor(row.id);
    expect(txEvents.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed']);
    const balanceEvents = await balanceChangedEventsFor(walletId, row.id);
    expect(balanceEvents).toHaveLength(1);
  });

  test('LOSS gera somente Processed, nenhum BalanceChanged', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId,
      kind: 'LOSS',
    });
    expect(response.status).toBe(201);

    const row = await wagerTransactionRow('provider-a', externalTransactionId);
    const rows = await outboxRowsFor(row.id);
    expect(rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed']);
    const balanceEvents = await balanceChangedEventsFor(walletId, row.id);
    expect(balanceEvents).toHaveLength(0);
  });
});

describe('Outbox — rejeicoes (Bloco 9a.2)', () => {
  async function expectSingleRejected(providerId: string, externalTransactionId: string, failureCode: FailureCode) {
    const row = await wagerTransactionRow(providerId, externalTransactionId);
    const rows = await outboxRowsFor(row.id);
    expect(rows.map((r) => r.event_type)).toEqual(['WagerTransactionRejected']);
    expect(rows[0].payload.data.failureCode).toBe(failureCode);
    expect(rows[0].payload.causationId).toBeUndefined();
    return rows[0];
  }

  test('PLAYER_MISMATCH', async () => {
    const { walletId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId: randomUUID(), // jogador diferente do dono da wallet
      externalTransactionId,
    });
    expect(response.status).toBe(422);
    await expectSingleRejected('provider-a', externalTransactionId, FailureCode.PlayerMismatch);
  });

  test('INSUFFICIENT_FUNDS', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const externalTransactionId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(response.status).toBe(422);
    await expectSingleRejected('provider-a', externalTransactionId, FailureCode.InsufficientFunds);
  });

  test('CURRENCY_MISMATCH', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId,
      money: { amount: '25.00', currency: 'USD' },
    });
    expect(response.status).toBe(422);
    await expectSingleRejected('provider-a', externalTransactionId, FailureCode.CurrencyMismatch);
  });

  test('INVALID_REFERENCE (REFUND apontando para uma WIN, nao uma BET)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    await submitWager(randomUUID(), { walletId, playerId, externalTransactionId: betExternalId, kind: 'BET' });

    const winExternalId = randomUUID();
    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: winExternalId,
      kind: 'WIN',
      money: { amount: '15.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });

    const refundExternalId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: refundExternalId,
      kind: 'REFUND',
      money: { amount: '15.00', currency: 'BRL' },
      referenceExternalTransactionId: winExternalId, // REFUND so aceita referenciar BET
    });
    expect(response.status).toBe(422);
    await expectSingleRejected('provider-a', refundExternalId, FailureCode.InvalidReference);
  });

  test('REFERENCE_ALREADY_REVERSED (segundo REFUND sobre a mesma BET)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    await submitWager(randomUUID(), { walletId, playerId, externalTransactionId: betExternalId, kind: 'BET' });

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });

    const secondRefundExternalId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: secondRefundExternalId,
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: betExternalId,
    });
    expect(response.status).toBe(422);
    await expectSingleRejected('provider-a', secondRefundExternalId, FailureCode.ReferenceAlreadyReversed);
  });

  test('BALANCE_LIMIT_EXCEEDED (overflow ao creditar)', async () => {
    const { walletId, playerId } = await createWallet('99999999999999999.99');
    const externalTransactionId = randomUUID();
    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId,
      kind: 'WIN',
      money: { amount: '0.01', currency: 'BRL' },
    });
    expect(response.status).toBe(422);
    await expectSingleRejected('provider-a', externalTransactionId, FailureCode.BalanceLimitExceeded);
  });
});

describe('Outbox — PENDING_REFERENCE e worker (Bloco 9a.2)', () => {
  test('entrada em PENDING_REFERENCE gera exatamente um PendingReference, com pending_reference_event_id gravado', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const refundExternalId = randomUUID();
    const missingRef = randomUUID();

    const response = await submitWager(
      randomUUID(),
      {
        walletId,
        playerId,
        externalTransactionId: refundExternalId,
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: missingRef,
      },
      'req-pending',
    );
    expect(response.status).toBe(202);

    const row = await wagerTransactionRow('provider-a', refundExternalId);
    expect(row.pending_reference_event_id).not.toBeNull();

    const rows = await outboxRowsFor(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('WagerTransactionPendingReference');
    expect(rows[0].payload.eventId).toBe(row.pending_reference_event_id as string);
    expect(rows[0].payload.correlationId).toBe('req-pending');
  });

  test('nova tentativa ainda pendente nao repete o evento PendingReference', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const refundExternalId = randomUUID();
    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: refundExternalId,
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: randomUUID(),
    });

    const row = await wagerTransactionRow('provider-a', refundExternalId);
    const didProcess = await worker.processDueOnce();
    expect(didProcess).toBe(true);

    const rows = await outboxRowsFor(row.id);
    expect(rows).toHaveLength(1); // ainda so o PendingReference original
    expect(rows[0].event_type).toBe('WagerTransactionPendingReference');
  });

  test('resolucao pelo worker gera Processed + BalanceChanged com o correlationId original e causationId apontando para o PendingReference', async () => {
    const { walletId, playerId } = await createWallet('100.00', 'req-original');
    const roundId = 'round-pending-1';
    const betExternalId = randomUUID();
    const refundExternalId = randomUUID();

    // REFUND chega ANTES da BET que ele referencia — fica PENDING_REFERENCE.
    await submitWager(
      randomUUID(),
      {
        walletId,
        playerId,
        roundId,
        externalTransactionId: refundExternalId,
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: betExternalId,
      },
      'req-original',
    );

    const pendingRow = await wagerTransactionRow('provider-a', refundExternalId);
    const originalEventId = pendingRow.pending_reference_event_id;

    // agora a BET chega
    await submitWager(randomUUID(), {
      walletId,
      playerId,
      roundId,
      externalTransactionId: betExternalId,
      kind: 'BET',
    });

    await forceDueNow(pendingRow.id);
    const didProcess = await worker.processDueOnce();
    expect(didProcess).toBe(true);

    const txEvents = await outboxRowsFor(pendingRow.id);
    expect(txEvents.map((r) => r.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);
    expect(txEvents[1].payload.correlationId).toBe('req-original');
    expect(txEvents[1].payload.causationId).toBe(originalEventId as string);

    const balanceEvents = await balanceChangedEventsFor(walletId, pendingRow.id);
    expect(balanceEvents).toHaveLength(1);
    expect(balanceEvents[0].payload.correlationId).toBe('req-original');
    expect(balanceEvents[0].payload.causationId).toBe(originalEventId as string);
  });

  test('TTL expirado gera Rejected com REFERENCE_NOT_FOUND, preservando correlationId e causationId', async () => {
    const { walletId, playerId } = await createWallet('100.00', 'req-ttl');
    const refundExternalId = randomUUID();

    await submitWager(
      randomUUID(),
      {
        walletId,
        playerId,
        externalTransactionId: refundExternalId,
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: randomUUID(),
      },
      'req-ttl',
    );

    const pendingRow = await wagerTransactionRow('provider-a', refundExternalId);
    const originalEventId = pendingRow.pending_reference_event_id;

    await backdateCreatedAt(pendingRow.id, 60); // TTL do worker e 30 min
    await forceDueNow(pendingRow.id);
    const didProcess = await worker.processDueOnce();
    expect(didProcess).toBe(true);

    const rows = await outboxRowsFor(pendingRow.id);
    expect(rows.map((r) => r.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(rows[1].payload.data.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(rows[1].payload.correlationId).toBe('req-ttl');
    expect(rows[1].payload.causationId).toBe(originalEventId as string);
  });
});

describe('Outbox — wallet inexistente, conflitos e replay (Bloco 9a.2)', () => {
  test('wallet inexistente: nenhuma WagerTransaction e nenhum evento sao criados', async () => {
    const before = await outboxCountTotal();
    const response = await submitWager(randomUUID(), { walletId: randomUUID(), playerId: randomUUID() });
    expect(response.status).toBe(404);
    const after = await outboxCountTotal();
    expect(after).toBe(before);
  });

  test('conflito 409 (mesma Idempotency-Key, payload diferente) nao cria evento novo', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const idempotencyKey = randomUUID();
    const externalTransactionId = randomUUID();

    await submitWager(idempotencyKey, { walletId, playerId, externalTransactionId, money: { amount: '25.00', currency: 'BRL' } });
    const row = await wagerTransactionRow('provider-a', externalTransactionId);
    const before = await outboxRowsFor(row.id);

    const response = await submitWager(idempotencyKey, {
      walletId,
      playerId,
      externalTransactionId,
      money: { amount: '30.00', currency: 'BRL' }, // payload diferente
    });
    expect(response.status).toBe(409);

    const after = await outboxRowsFor(row.id);
    expect(after).toHaveLength(before.length);
  });

  test('replay com a mesma Idempotency-Key nao cria nova linha na Outbox', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const idempotencyKey = randomUUID();
    const externalTransactionId = randomUUID();
    const overrides = { walletId, playerId, externalTransactionId, money: { amount: '25.00', currency: 'BRL' } };

    const first = await submitWager(idempotencyKey, overrides);
    const firstBody = (await first.json()) as SubmitBody;

    const row = await wagerTransactionRow('provider-a', externalTransactionId);
    const txEventsBefore = await outboxRowsFor(row.id);
    const balanceEventsBefore = await balanceChangedEventsFor(walletId, row.id);
    expect(txEventsBefore).toHaveLength(1); // Processed
    expect(balanceEventsBefore).toHaveLength(1); // BalanceChanged

    const second = await submitWager(idempotencyKey, overrides);
    const secondBody = (await second.json()) as SubmitBody;

    expect(second.status).toBe(200);
    expect(secondBody.idempotentReplay).toBe(true);
    expect(secondBody.balance).toEqual(firstBody.balance);

    const txEventsAfter = await outboxRowsFor(row.id);
    const balanceEventsAfter = await balanceChangedEventsFor(walletId, row.id);
    expect(txEventsAfter).toHaveLength(1); // nao dobrou
    expect(balanceEventsAfter).toHaveLength(1); // nao dobrou
  });
});

describe('Outbox — correlationId (Bloco 9a.2)', () => {
  test('header valido e preservado e ecoado', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const response = await submitWager(randomUUID(), { walletId, playerId, externalTransactionId }, 'meu-trace-123');

    expect(response.headers.get('x-correlation-id')).toBe('meu-trace-123');
    const row = await wagerTransactionRow('provider-a', externalTransactionId);
    expect(row.correlation_id).toBe('meu-trace-123');
  });

  test('header ausente gera um correlationId novo, consistente entre resposta e persistencia', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const response = await submitWager(randomUUID(), { walletId, playerId, externalTransactionId });

    const echoed = response.headers.get('x-correlation-id');
    expect(echoed).toBeTruthy();
    const row = await wagerTransactionRow('provider-a', externalTransactionId);
    expect(row.correlation_id).toBe(echoed as string);
  });

  test('header malformado e substituido por um correlationId gerado, requisicao nao e rejeitada', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const response = await submitWager(
      randomUUID(),
      { walletId, playerId, externalTransactionId },
      'bad#correlation#id', // fora do formato aceito (so [A-Za-z0-9_.:-]), mas ainda um header HTTP valido
    );

    expect(response.status).toBe(201);
    const echoed = response.headers.get('x-correlation-id');
    expect(echoed).not.toBe('bad#correlation#id');
    const row = await wagerTransactionRow('provider-a', externalTransactionId);
    expect(row.correlation_id).toBe(echoed as string);
  });

  test('correlationId e ecoado mesmo numa resposta de rejeicao (422)', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const response = await submitWager(
      randomUUID(),
      { walletId, playerId, money: { amount: '25.00', currency: 'BRL' } },
      'req-rejeicao',
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('x-correlation-id')).toBe('req-rejeicao');
  });

  test('correlationId e ecoado mesmo numa resposta 404 (wallet inexistente)', async () => {
    const response = await submitWager(
      randomUUID(),
      { walletId: randomUUID(), playerId: randomUUID() },
      'req-404',
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toBe('req-404');
  });
});

describe('Outbox — atomicidade e savepoint (Bloco 9a.2)', () => {
  test('erro na transacao externa desfaz wallet, WagerTransaction, ledger e Outbox juntos; chamada aninhada nao abre transacao propria', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const idempotencyKey = randomUUID();

    class ForcedRollback extends Error {}

    const em: EntityManager = orm.em.fork();

    const dto: SubmitWagerTransactionDto = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    await expect(
      em.transactional(async (trxEm) => {
        // O use case precisa ser construido com o `trxEm` que o proprio
        // em.transactional() acabou de vincular a transacao ja aberta — nao
        // com o `em` de fora. Construi-lo com o `em` de fora (antes do
        // transactional) e o erro classico que faz a chamada interna abrir
        // sua PROPRIA transacao independente em vez de participar desta.
        const useCase = new SubmitWagerTransactionUseCase(trxEm);
        await useCase.execute(idempotencyKey, dto, randomUUID());
        // a essa altura, se a chamada acima tivesse aberto e commitado sua
        // propria transacao independente, os efeitos ja estariam gravados —
        // o throw abaixo nao teria como desfaze-los.
        throw new ForcedRollback('forced before external commit');
      }),
    ).rejects.toThrow(ForcedRollback);

    const balanceRows = await orm.em
      .getConnection()
      .execute<{ balance_amount: string }[]>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
    expect(balanceRows[0].balance_amount).toBe('100.00'); // saldo da OPENING, BET nao aplicada

    const txRows = await orm.em
      .getConnection()
      .execute('SELECT * FROM wager_transactions WHERE external_transaction_id = ?', [externalTransactionId]);
    expect(txRows).toHaveLength(0);

    const ledgerCountRows = await orm.em
      .getConnection()
      .execute<{ count: number }[]>('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ?', [
        walletId,
      ]);
    expect(ledgerCountRows[0].count).toBe(1); // so a entrada da OPENING, nenhuma do BET

    const outboxCountRows = await orm.em
      .getConnection()
      .execute<{ count: number }[]>('SELECT count(*)::int AS count FROM outbox_messages WHERE aggregate_id = ?', [
        walletId,
      ]);
    expect(outboxCountRows[0].count).toBe(1); // so o WalletBalanceChanged da OPENING

    // prova de que a wallet nao ficou presa/travada: uma chamada normal
    // depois disso ainda funciona, saldo continua correto.
    const followUp = await submitWager(randomUUID(), { walletId, playerId, money: { amount: '10.00', currency: 'BRL' } });
    expect(followUp.status).toBe(201);
  });
});
