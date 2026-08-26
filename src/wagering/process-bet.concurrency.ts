import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';

/**
 * Teste de concorrencia real: duas BET diferentes de 80.00 sobre uma wallet
 * com saldo 100.00, disparadas com Promise.all — SEM await entre as duas
 * chamadas de fetch. Cada requisicao HTTP abre sua propria conexao do pool
 * do MikroORM e sua propria transacao SQL; o lock que decide o resultado
 * (SELECT ... FOR UPDATE) e do Postgres, entre transacoes reais — nao um
 * mutex do processo Node. Isso prova a garantia entre instancias para o
 * cenario de disputa de saldo da secao 8 do CHALLENGE.md.
 *
 * Nao e o teste de "3+ processos/instancias" da secao 13 (item 4) — esse
 * fica pendente para um bloco de concorrencia dedicado, com mais de um
 * processo Nest real.
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
  await orm.em.getConnection().execute('TRUNCATE TABLE wallet_ledger_entries, wager_transactions, wallets');
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

async function createWallet(initialAmount: string): Promise<string> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: initialAmount, currency: 'BRL' } }),
  });
  const body = (await response.json()) as OpenWalletBody;
  return body.id;
}

function submitBet(walletId: string, idempotencyKey: string, externalTransactionId: string): Promise<Response> {
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId,
      playerId: randomUUID(),
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    }),
  });
}

describe('Concorrencia real: duas BET de 80 disputando saldo 100', () => {
  test('exatamente uma PROCESSED, exatamente uma REJECTED, saldo final 20, um unico ledger', async () => {
    const walletId = await createWallet('100.00');

    const [responseA, responseB] = await Promise.all([
      submitBet(walletId, randomUUID(), 'ext-bet-a'),
      submitBet(walletId, randomUUID(), 'ext-bet-b'),
    ]);

    const [bodyA, bodyB] = await Promise.all([
      responseA.json() as Promise<SubmitBetBody>,
      responseB.json() as Promise<SubmitBetBody>,
    ]);

    const statuses = [bodyA.status, bodyB.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const httpStatuses = [responseA.status, responseB.status].sort();
    expect(httpStatuses).toEqual([201, 422]);

    const conn = orm.em.getConnection();

    const wallets = (await conn.execute('SELECT balance_amount FROM wallets WHERE id = ?', [walletId])) as {
      balance_amount: string;
    }[];
    expect(wallets[0].balance_amount).toBe('20.00');
    expect(Number(wallets[0].balance_amount)).toBeGreaterThanOrEqual(0);

    // a wallet fixture ja nasce com 1 lancamento CREDIT de OPENING (Bloco 5) e
    // 1 WagerTransaction OPENING/PROCESSED — filtramos por DEBIT/kind=BET para
    // contar so o efeito das duas apostas desta disputa.
    const ledgerCount = (await conn.execute(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    )) as { count: number }[];
    expect(ledgerCount[0].count).toBe(1);

    const processedCount = (await conn.execute(
      `SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
      [walletId],
    )) as { count: number }[];
    expect(processedCount[0].count).toBe(1);

    const rejectedCount = (await conn.execute(
      `SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'REJECTED'`,
      [walletId],
    )) as { count: number }[];
    expect(rejectedCount[0].count).toBe(1);
  });
});
