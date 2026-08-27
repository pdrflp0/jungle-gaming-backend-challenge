import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';

/**
 * Teste de concorrencia real: a MESMA BET (mesma Idempotency-Key, mesmo
 * payload) enviada 50 vezes via Promise.all — sem await entre as chamadas.
 * Cada requisicao abre sua propria conexao/transacao; a garantia de que so
 * uma "vence" e a constraint UNIQUE(idempotency_key), nunca uma verificacao
 * em memoria.
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

interface SubmitBetBody {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
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

describe('Concorrencia real: 50 envios paralelos da mesma BET', () => {
  test('uma unica WagerTransaction, um unico debito, um unico ledger, 49 replays', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const idempotencyKey = randomUUID();

    const payload = JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet-duplicada',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const requests = Array.from({ length: 50 }, () =>
      fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: payload,
      }),
    );

    const responses = await Promise.all(requests);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as SubmitBetBody[];

    const transactionIds = new Set(bodies.map((body) => body.transactionId));
    expect(transactionIds.size).toBe(1);

    const httpStatuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(httpStatuses.filter((status) => status === 201)).toHaveLength(1);
    expect(httpStatuses.filter((status) => status === 200)).toHaveLength(49);

    const fresh = bodies.filter((body) => body.idempotentReplay === false);
    const replays = bodies.filter((body) => body.idempotentReplay === true);
    expect(fresh).toHaveLength(1);
    expect(replays).toHaveLength(49);

    const conn = orm.em.getConnection();

    // a wallet fixture ja nasce com 1 WagerTransaction OPENING/PROCESSED e 1
    // lancamento CREDIT de OPENING (Bloco 5) — filtramos por kind=BET/DEBIT
    // para contar so o efeito das 50 tentativas desta mesma BET.
    const transactionCount = (await conn.execute(
      `SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`,
      [walletId],
    )) as { count: number }[];
    expect(transactionCount[0].count).toBe(1);

    const ledgerCount = (await conn.execute(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    )) as { count: number }[];
    expect(ledgerCount[0].count).toBe(1);

    const wallets = (await conn.execute('SELECT balance_amount FROM wallets WHERE id = ?', [walletId])) as {
      balance_amount: string;
    }[];
    expect(wallets[0].balance_amount).toBe('90.00');
  });
});
