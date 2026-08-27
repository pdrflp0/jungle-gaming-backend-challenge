import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';
import type { WagerTransactionQueryResponse } from './get-wager-transaction.use-case';

/**
 * Teste de integracao real dos GETs de transacao (Bloco 8a):
 * GET /wagering/transactions/:id e GET /providers/:providerId/wagering/transactions/:externalId.
 *
 * Sem sufixo .spec./.test. de proposito — nao entra no `bun test` padrao.
 * Roda so via `bun run test:integration`.
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
  playerId: string;
}

interface SubmitBody {
  transactionId: string;
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

async function submitWager(overrides: Record<string, unknown>): Promise<SubmitBody> {
  const payload: Record<string, unknown> = {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as SubmitBody;
}

function getById(transactionId: string): Promise<Response> {
  return fetch(`${baseUrl}/wagering/transactions/${transactionId}`);
}

function getByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<Response> {
  return fetch(`${baseUrl}/providers/${providerId}/wagering/transactions/${externalTransactionId}`);
}

async function countAll(): Promise<{ wallets: number; transactions: number; ledgerEntries: number }> {
  const conn = orm.em.getConnection();
  const [wallets] = await conn.execute('SELECT count(*)::int AS count FROM wallets');
  const [transactions] = await conn.execute('SELECT count(*)::int AS count FROM wager_transactions');
  const [ledgerEntries] = await conn.execute('SELECT count(*)::int AS count FROM wallet_ledger_entries');
  return { wallets: wallets.count, transactions: transactions.count, ledgerEntries: ledgerEntries.count };
}

describe('GET /wagering/transactions/:id e GET /providers/:providerId/wagering/transactions/:externalId', () => {
  test('BET PROCESSED: 200, com balance historico, sem failureCode, sem payloadHash/idempotencyKey', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const { transactionId } = await submitWager({
      walletId,
      playerId,
      externalTransactionId,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    const response = await getById(transactionId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as WagerTransactionQueryResponse & Record<string, unknown>;

    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(body.failureCode).toBeUndefined();
    expect(body).not.toHaveProperty('payloadHash');
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(body.kind).toBe('BET');
  });

  test('BET REJECTED por saldo insuficiente: 200, status REJECTED, failureCode presente, balance historico (saldo antes, inalterado)', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const { transactionId } = await submitWager({
      walletId,
      playerId,
      kind: 'BET',
      money: { amount: '50.00', currency: 'BRL' },
    });

    const response = await getById(transactionId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as WagerTransactionQueryResponse;

    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(body.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('WIN com referencia inexistente (PENDING_REFERENCE): 200, sem balance nem failureCode', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const { transactionId } = await submitWager({
      walletId,
      playerId,
      kind: 'WIN',
      referenceExternalTransactionId: 'nunca-vai-chegar',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const response = await getById(transactionId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as WagerTransactionQueryResponse;

    expect(body.status).toBe('PENDING_REFERENCE');
    expect(body.balance).toBeUndefined();
    expect(body.failureCode).toBeUndefined();
  });

  test('id inexistente retorna 404; uuid malformado retorna 400', async () => {
    expect((await getById(randomUUID())).status).toBe(404);
    expect((await getById('nao-e-um-uuid')).status).toBe(400);
  });

  test('a mesma transacao consultada pelas duas rotas produz corpo identico', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const { transactionId } = await submitWager({
      walletId,
      playerId,
      externalTransactionId,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    const byId = await getById(transactionId);
    const byProvider = await getByProviderAndExternalId('provider-a', externalTransactionId);

    expect(byId.status).toBe(200);
    expect(byProvider.status).toBe(200);
    expect(await byProvider.json()).toEqual(await byId.json());
  });

  test('provider ou externalTransactionId inexistentes retornam 404', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    await submitWager({ walletId, playerId, externalTransactionId, kind: 'BET' });

    expect((await getByProviderAndExternalId('provider-a', 'nao-existe')).status).toBe(404);
    expect((await getByProviderAndExternalId('provider-que-nao-existe', externalTransactionId)).status).toBe(404);
  });

  test('consultas de leitura nao alteram saldo, ledger nem contagem de transacoes', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const externalTransactionId = randomUUID();
    const { transactionId } = await submitWager({ walletId, playerId, externalTransactionId, kind: 'BET' });

    const before = await countAll();

    await getById(transactionId);
    await getByProviderAndExternalId('provider-a', externalTransactionId);

    const after = await countAll();
    expect(after).toEqual(before);
  });
});
