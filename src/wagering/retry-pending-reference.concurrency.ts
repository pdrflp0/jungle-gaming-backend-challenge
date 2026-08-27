import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../app.module';
import { RetryPendingReferenceWorker } from './retry-pending-reference.worker';

/**
 * Teste de concorrencia real: duas "instancias" do worker disputando a MESMA
 * linha PENDING_REFERENCE devida.
 *
 * Um Promise.all chamando o mesmo `this.em` injetado por Nest nao provaria
 * independencia de verdade — por isso aqui cada worker recebe seu PROPRIO
 * EntityManager, obtido via `orm.em.fork()`: cada fork tem seu proprio mapa
 * de identidade e, quando `em.transactional()` roda, pega sua propria conexao
 * do pool — sao duas transacoes independentes de verdade contra o mesmo
 * PostgreSQL, exatamente como duas instancias da aplicacao rodando em
 * processos/maquinas diferentes fariam. O `RetryPendingReferenceWorker` e
 * instanciado diretamente (sem passar pelo container do Nest) para deixar
 * essa independencia inspecionavel no proprio teste, nao escondida atras de
 * um singleton.
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

function submitWager(idempotencyKey: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  });
}

describe('Concorrencia real: dois workers disputando a mesma PENDING_REFERENCE devida', () => {
  test('so um worker processa a linha; o outro nao encontra nada (FOR UPDATE SKIP LOCKED)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();

    const pending = await submitWager(randomUUID(), {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(pending.status).toBe(202);
    const { transactionId } = (await pending.json()) as SubmitBody;

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

    // Duas conexoes/transacoes independentes contra o mesmo Postgres.
    const emA = orm.em.fork();
    const emB = orm.em.fork();
    const workerA = new RetryPendingReferenceWorker(emA);
    const workerB = new RetryPendingReferenceWorker(emB);

    const [claimedA, claimedB] = await Promise.all([workerA.processDueOnce(), workerB.processDueOnce()]);

    const claims = [claimedA, claimedB].sort();
    expect(claims).toEqual([false, true]);

    const rows = (await orm.em
      .getConnection()
      .execute('SELECT status FROM wager_transactions WHERE id = ?', [transactionId])) as { status: string }[];
    expect(rows[0].status).toBe('PROCESSED');

    const wallets = (await orm.em
      .getConnection()
      .execute('SELECT balance_amount FROM wallets WHERE id = ?', [walletId])) as { balance_amount: string }[];
    // 100 - 30 (BET) + 30 (uma unica REFUND aplicada por um unico worker) = 100.
    expect(wallets[0].balance_amount).toBe('100.00');

    const creditCount = (await orm.em.getConnection().execute(
      `SELECT count(*)::int AS count FROM wallet_ledger_entries le
       JOIN wager_transactions wt ON wt.id = le.transaction_id
       WHERE le.wallet_id = ? AND le.direction = 'CREDIT' AND wt.kind = 'REFUND'`,
      [walletId],
    )) as { count: number }[];
    expect(creditCount[0].count).toBe(1);
  });
});
