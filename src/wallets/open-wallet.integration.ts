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
 * Sem sufixo .spec./.test. de proposito: o `bun test` padrao nao descobre
 * este arquivo. Roda so via `bun run test:integration`.
 */

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;
const createdWalletIds: string[] = [];

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
  const conn = orm.em.getConnection();
  if (createdWalletIds.length > 0) {
    // o ledger e append-only de proposito (Bloco 4) — so aqui, so para limpar
    // dados de teste, desligamos o trigger, apagamos, e religamos no finally.
    await conn.execute('ALTER TABLE wallet_ledger_entries DISABLE TRIGGER wallet_ledger_entries_append_only');
    try {
      for (const walletId of createdWalletIds) {
        await conn.execute('DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
      }
    } finally {
      await conn.execute('ALTER TABLE wallet_ledger_entries ENABLE TRIGGER wallet_ledger_entries_append_only');
    }
    for (const walletId of createdWalletIds) {
      await conn.execute('DELETE FROM wager_transactions WHERE wallet_id = ?', [walletId]);
      await conn.execute('DELETE FROM wallets WHERE id = ?', [walletId]);
    }
  }
  createdWalletIds.length = 0;
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

describe('POST /wallets (integracao real com Postgres)', () => {
  test('abre wallet com saldo zero — persiste somente a wallet', async () => {
    const playerId = randomUUID();

    const response = await openWallet({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(response.status).toBe(201);

    const body = (await response.json()) as OpenWalletResult;
    createdWalletIds.push(body.id);

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
    createdWalletIds.push(body.id);
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
    const firstBody = (await first.json()) as OpenWalletResult;
    createdWalletIds.push(firstBody.id);

    const conn = orm.em.getConnection();
    const before = await conn.execute('SELECT count(*)::int AS count FROM wallets WHERE player_id = ?', [
      playerId,
    ]);

    const second = await openWallet(payload);
    expect(second.status).toBe(409);

    const after = await conn.execute('SELECT count(*)::int AS count FROM wallets WHERE player_id = ?', [
      playerId,
    ]);
    expect(after[0].count).toBe(before[0].count);
  });
});
