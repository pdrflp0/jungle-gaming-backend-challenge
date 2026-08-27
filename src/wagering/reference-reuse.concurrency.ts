import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';

/**
 * Teste de concorrencia real: duas REFUND diferentes (idempotency keys
 * distintas) da MESMA BET, disparadas com Promise.all — sem await entre
 * elas. A unidade de concorrencia e a wallet: as duas reversoes disputam a
 * MESMA linha de wallet (SELECT ... FOR UPDATE), entao o lock do Postgres
 * serializa as duas — quando a segunda finalmente roda sua checagem "essa
 * referencia ja foi revertida?", a primeira ja commitou de verdade. Por
 * isso o resultado esperado e sempre deterministico (uma PROCESSED, uma
 * REJECTED/REFERENCE_ALREADY_REVERSED) — 503 nunca e um resultado aceitavel
 * aqui; isso e regra de negocio conhecida, nao falha transitoria.
 *
 * Sem sufixo .spec./.test. de proposito — nao entra no `bun test` padrao.
 * Roda so via `bun run test:concurrency`.
 */

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : address;
  baseUrl = `http://127.0.0.1:${port}`;
  orm = app.get(MikroORM);
});

afterEach(async () => {
  await orm.em.getConnection().execute('TRUNCATE TABLE outbox_messages, wallet_ledger_entries, wager_transactions, wallets');
});

afterAll(async () => {
  await app.close();
});

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

async function createWallet(initialAmount: string): Promise<{ walletId: string; playerId: string }> {
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
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  });
}

describe('Concorrencia real: duas REFUND simultaneas da mesma BET', () => {
  test('exatamente uma PROCESSED, exatamente uma REJECTED/REFERENCE_ALREADY_REVERSED, nunca 503', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();

    const betResponse = await submitWager(randomUUID(), {
      providerId: 'provider-a',
      externalTransactionId: betExternalId,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(betResponse.status).toBe(201);

    const refundPayload = (externalTransactionId: string) => ({
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '30.00', currency: 'BRL' },
    });

    const [responseA, responseB] = await Promise.all([
      submitWager(randomUUID(), refundPayload('ext-refund-a')),
      submitWager(randomUUID(), refundPayload('ext-refund-b')),
    ]);

    const [bodyA, bodyB] = await Promise.all([
      responseA.json() as Promise<SubmitBody>,
      responseB.json() as Promise<SubmitBody>,
    ]);

    const httpStatuses = [responseA.status, responseB.status].sort((a, b) => a - b);
    expect(httpStatuses).toEqual([201, 422]);
    expect(httpStatuses).not.toContain(503);

    const statuses = [bodyA.status, bodyB.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const rejected = bodyA.status === 'REJECTED' ? bodyA : bodyB;
    expect(rejected.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    const conn = orm.em.getConnection();

    const wallets = (await conn.execute('SELECT balance_amount FROM wallets WHERE id = ?', [walletId])) as {
      balance_amount: string;
    }[];
    // saldo 100 - 30 (BET) + 30 (uma unica REFUND aplicada) = 100.
    expect(wallets[0].balance_amount).toBe('100.00');

    const creditCount = (await conn.execute(
      `SELECT count(*)::int AS count FROM wallet_ledger_entries le
       JOIN wager_transactions wt ON wt.id = le.transaction_id
       WHERE le.wallet_id = ? AND le.direction = 'CREDIT' AND wt.kind = 'REFUND'`,
      [walletId],
    )) as { count: number }[];
    expect(creditCount[0].count).toBe(1);
  });
});
