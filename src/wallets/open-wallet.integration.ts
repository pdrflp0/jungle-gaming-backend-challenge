import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';
import type { OpenWalletResult } from './open-wallet.use-case';

/**
 * Teste de integracao real: sobe a aplicacao Nest inteira (com o
 * ValidationPipe global) e chama o endpoint HTTP via fetch — nao chama o
 * caso de uso diretamente. Exige Postgres no ar com a migration aplicada
 * (`docker compose up -d postgres` + `bun run migration:up`).
 *
 * Roda contra um banco local/descartavel de integracao: o afterEach faz
 * TRUNCATE nas tres tabelas funcionais entre testes. TRUNCATE nao dispara
 * trigger de DELETE nem altera o estado de nenhum trigger — o append-only
 * do ledger continua habilitado o tempo todo.
 *
 * Sem sufixo .spec./.test. de proposito: o `bun test` padrao nao descobre
 * este arquivo. Roda so via `bun run test:integration`.
 */

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
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

function openWallet(payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function countAll(): Promise<{ wallets: number; transactions: number; ledgerEntries: number }> {
  const conn = orm.em.getConnection();
  const [wallets] = await conn.execute('SELECT count(*)::int AS count FROM wallets');
  const [transactions] = await conn.execute('SELECT count(*)::int AS count FROM wager_transactions');
  const [ledgerEntries] = await conn.execute('SELECT count(*)::int AS count FROM wallet_ledger_entries');
  return { wallets: wallets.count, transactions: transactions.count, ledgerEntries: ledgerEntries.count };
}

describe('POST /wallets (integracao real com Postgres)', () => {
  test('abre wallet com saldo zero — persiste somente a wallet', async () => {
    const playerId = randomUUID();

    const response = await openWallet({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(response.status).toBe(201);

    const body = (await response.json()) as OpenWalletResult;

    expect(body).toEqual({
      id: body.id,
      playerId,
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });

    const conn = orm.em.getConnection();
    const wallets = await conn.execute('SELECT * FROM wallets WHERE id = ?', [body.id]);
    expect(wallets).toHaveLength(1);

    const transactions = await conn.execute('SELECT * FROM wager_transactions WHERE wallet_id = ?', [body.id]);
    expect(transactions).toHaveLength(0);
  });

  test('abre wallet com saldo positivo — wallet, OPENING e ledger existem e estao ligados corretamente', async () => {
    const playerId = randomUUID();

    const response = await openWallet({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as OpenWalletResult;
    expect(body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(body.version).toBe(1);

    const conn = orm.em.getConnection();

    const wallets = await conn.execute('SELECT * FROM wallets WHERE id = ?', [body.id]);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].balance_amount).toBe('1000.00');

    const transactions = await conn.execute(
      `SELECT * FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'`,
      [body.id],
    );
    expect(transactions).toHaveLength(1);
    expect(transactions[0].status).toBe('PROCESSED');
    expect(transactions[0].amount).toBe('1000.00');

    const ledgerEntries = await conn.execute('SELECT * FROM wallet_ledger_entries WHERE wallet_id = ?', [
      body.id,
    ]);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].direction).toBe('CREDIT');
    expect(ledgerEntries[0].amount).toBe('1000.00');
    expect(ledgerEntries[0].balance_before).toBe('0.00');
    expect(ledgerEntries[0].balance_after).toBe('1000.00');

    // a mesma transactionId liga o lancamento a transacao OPENING.
    expect(ledgerEntries[0].transaction_id).toBe(transactions[0].id);
  });

  test('wallet duplicada (mesmo playerId + currency) retorna 409 e nao deixa linha nova', async () => {
    const playerId = randomUUID();
    const payload = { playerId, initialBalance: { amount: '0.00', currency: 'BRL' } };

    const first = await openWallet(payload);
    expect(first.status).toBe(201);

    const before = await countAll();

    const second = await openWallet(payload);
    expect(second.status).toBe(409);

    const after = await countAll();
    expect(after).toEqual(before);
  });

  test('valor acima do limite (NUMERIC(19,2)) retorna 400 e nao persiste nada', async () => {
    const playerId = randomUUID();

    const response = await openWallet({
      playerId,
      initialBalance: { amount: '100000000000000000.00', currency: 'BRL' },
    });

    expect(response.status).toBe(400);
    expect(await countAll()).toEqual({ wallets: 0, transactions: 0, ledgerEntries: 0 });
  });

  test('payload com campo extra retorna 400 (forbidNonWhitelisted) e nao persiste nada', async () => {
    const playerId = randomUUID();

    const response = await openWallet({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
      unexpectedField: 'nao deveria existir',
    });

    expect(response.status).toBe(400);
    expect(await countAll()).toEqual({ wallets: 0, transactions: 0, ledgerEntries: 0 });
  });
});
