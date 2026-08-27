import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';
import { encodeLedgerCursor } from './ledger-cursor';
import type { GetWalletLedgerResponse } from './get-wallet-ledger.use-case';
import type { GetWalletResponse } from './get-wallet.use-case';
import type { OpenWalletResult } from './open-wallet.use-case';

/**
 * Teste de integracao real dos GETs de wallet (Bloco 8a): GET /wallets/:id e
 * GET /wallets/:id/ledger. Sobe a aplicacao Nest inteira e chama via fetch.
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

async function openWallet(initialAmount: string): Promise<OpenWalletResult> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } }),
  });
  return (await response.json()) as OpenWalletResult;
}

async function submitBet(walletId: string, playerId: string, amount: string): Promise<void> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(201);
}

function getWallet(walletId: string): Promise<Response> {
  return fetch(`${baseUrl}/wallets/${walletId}`);
}

function getLedger(walletId: string, query = ''): Promise<Response> {
  return fetch(`${baseUrl}/wallets/${walletId}/ledger${query}`);
}

async function countAll(): Promise<{ wallets: number; transactions: number; ledgerEntries: number }> {
  const conn = orm.em.getConnection();
  const [wallets] = await conn.execute('SELECT count(*)::int AS count FROM wallets');
  const [transactions] = await conn.execute('SELECT count(*)::int AS count FROM wager_transactions');
  const [ledgerEntries] = await conn.execute('SELECT count(*)::int AS count FROM wallet_ledger_entries');
  return { wallets: wallets.count, transactions: transactions.count, ledgerEntries: ledgerEntries.count };
}

describe('GET /wallets/:walletId (integracao real com Postgres)', () => {
  test('wallet existente retorna exatamente id, playerId, balance e version', async () => {
    const wallet = await openWallet('1000.00');

    const response = await getWallet(wallet.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as GetWalletResponse;

    expect(body).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('wallet inexistente retorna 404', async () => {
    const response = await getWallet(randomUUID());
    expect(response.status).toBe(404);
  });

  test('uuid malformado no path retorna 400', async () => {
    const response = await getWallet('nao-e-um-uuid');
    expect(response.status).toBe(400);
  });
});

describe('GET /wallets/:walletId/ledger (integracao real com Postgres)', () => {
  test('wallet inexistente retorna 404 sem consultar o ledger', async () => {
    const response = await getLedger(randomUUID());
    expect(response.status).toBe(404);
  });

  test('uuid malformado no path retorna 400', async () => {
    const response = await getLedger('nao-e-um-uuid');
    expect(response.status).toBe(400);
  });

  test('ledger so com OPENING: 1 entrada, walletId no objeto principal, nextCursor null', async () => {
    const wallet = await openWallet('500.00');

    const response = await getLedger(wallet.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as GetWalletLedgerResponse;

    expect(body.walletId).toBe(wallet.id);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].direction).toBe('CREDIT');
    expect(body.entries[0].money).toEqual({ amount: '500.00', currency: 'BRL' });
    expect(body.entries[0].balanceBefore).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(body.entries[0].balanceAfter).toEqual({ amount: '500.00', currency: 'BRL' });
    expect(body.nextCursor).toBeNull();
    // walletId nao se repete dentro de cada entry.
    expect(body.entries[0]).not.toHaveProperty('walletId');
  });

  test('pagina o ledger inteiro com limit=2 sem duplicar nem pular lancamentos', async () => {
    const wallet = await openWallet('1000.00');
    for (let i = 0; i < 4; i += 1) {
      await submitBet(wallet.id, wallet.playerId, '10.00');
    }
    // 1 OPENING (credit) + 4 BET (debit) = 5 lancamentos.

    const reference = (await orm.em
      .getConnection()
      .execute('SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at, id', [
        wallet.id,
      ])) as { id: string }[];
    expect(reference).toHaveLength(5);

    const collectedIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const response = await getLedger(wallet.id, query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as GetWalletLedgerResponse;

      expect(body.entries.length).toBeLessThanOrEqual(2);
      collectedIds.push(...body.entries.map((entry) => entry.id));
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      if (pages > 10) {
        throw new Error('paginacao nao terminou — possivel loop infinito');
      }
    } while (cursor);

    expect(collectedIds).toEqual(reference.map((row) => row.id));
    expect(new Set(collectedIds).size).toBe(5); // nenhum id duplicado
    expect(pages).toBe(3); // 2 + 2 + 1
  });

  test('cursor malformado retorna 400', async () => {
    const wallet = await openWallet('100.00');
    const response = await getLedger(wallet.id, '?cursor=nao-e-base64url!!!');
    expect(response.status).toBe(400);
  });

  test('cursor com uuid invalido dentro (mas base64url valido) retorna 400', async () => {
    const wallet = await openWallet('100.00');
    const fakeCursor = Buffer.from('2026-08-28T12:00:00.000Z|nao-e-um-uuid', 'utf8').toString('base64url');
    const response = await getLedger(wallet.id, `?cursor=${fakeCursor}`);
    expect(response.status).toBe(400);
  });

  test('limit invalido (0, negativo, acima do maximo, nao numerico) retorna 400', async () => {
    const wallet = await openWallet('100.00');

    expect((await getLedger(wallet.id, '?limit=0')).status).toBe(400);
    expect((await getLedger(wallet.id, '?limit=-1')).status).toBe(400);
    expect((await getLedger(wallet.id, '?limit=201')).status).toBe(400);
    expect((await getLedger(wallet.id, '?limit=abc')).status).toBe(400);
  });

  test('limit ausente usa o padrao 50 (nao rejeita, nao trava)', async () => {
    const wallet = await openWallet('100.00');
    const response = await getLedger(wallet.id);
    expect(response.status).toBe(200);
  });

  test('cursor valido mas com um UUID que existe em outra wallet ainda funciona (cursor e opaco, nao autorizacao)', async () => {
    // Um cursor valido de outra wallet, aplicado aqui, so filtra por
    // (created_at, id) — nao vaza nada alem do que a paginacao ja mostraria.
    const walletA = await openWallet('100.00');
    const walletB = await openWallet('200.00');

    const entryA = (await orm.em
      .getConnection()
      .execute('SELECT id, created_at FROM wallet_ledger_entries WHERE wallet_id = ?', [
        walletA.id,
      ])) as { id: string; created_at: Date }[];
    const cursorFromWalletA = encodeLedgerCursor(new Date(entryA[0].created_at), entryA[0].id);

    const response = await getLedger(walletB.id, `?cursor=${cursorFromWalletA}`);
    expect(response.status).toBe(200);
  });

  test('consultas de leitura nao alteram saldo, ledger nem contagem de transacoes', async () => {
    const wallet = await openWallet('300.00');
    await submitBet(wallet.id, wallet.playerId, '50.00');

    const before = await countAll();
    const balanceBefore = (await orm.em
      .getConnection()
      .execute('SELECT balance_amount FROM wallets WHERE id = ?', [wallet.id])) as { balance_amount: string }[];

    await getWallet(wallet.id);
    await getLedger(wallet.id);
    await getLedger(wallet.id, '?limit=1');

    const after = await countAll();
    const balanceAfter = (await orm.em
      .getConnection()
      .execute('SELECT balance_amount FROM wallets WHERE id = ?', [wallet.id])) as { balance_amount: string }[];

    expect(after).toEqual(before);
    expect(balanceAfter[0].balance_amount).toBe(balanceBefore[0].balance_amount);
  });
});
