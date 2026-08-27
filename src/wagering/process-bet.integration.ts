import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';

/**
 * Teste de integracao real: sobe a aplicacao Nest inteira e chama os
 * endpoints HTTP via fetch — POST /wallets (Bloco 5) para preparar a
 * fixture e POST /wagering/transactions (este bloco).
 *
 * Roda contra um banco local/descartavel: o afterEach faz TRUNCATE nas
 * tres tabelas funcionais entre testes.
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
  balance: { amount: string; currency: string };
  version: number;
}

interface SubmitBetBody {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

interface Wallet {
  walletId: string;
  playerId: string;
}

async function createWallet(initialAmount: string, currency = 'BRL'): Promise<Wallet> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency } }),
  });
  const body = (await response.json()) as OpenWalletBody;
  return { walletId: body.id, playerId };
}

function submitBet(
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
  }>,
): Promise<Response> {
  const payload = {
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

async function walletBalance(walletId: string): Promise<string> {
  const rows = (await orm.em
    .getConnection()
    .execute('SELECT balance_amount FROM wallets WHERE id = ?', [walletId])) as { balance_amount: string }[];
  return rows[0].balance_amount;
}

/**
 * Conta so lancamentos DEBIT — a wallet fixture ja nasce com um CREDIT de
 * OPENING (Bloco 5) quando criada com saldo inicial positivo, entao contar
 * "todos os lancamentos" incluiria esse CREDIT junto com os DEBIT das BETs.
 */
async function countDebitLedgerEntries(walletId: string): Promise<number> {
  const rows = (await orm.em
    .getConnection()
    .execute(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    )) as { count: number }[];
  return rows[0].count;
}

describe('POST /wagering/transactions — BET (integracao real com Postgres)', () => {
  test('BET de 25 sobre saldo 100: PROCESSED, saldo 75, um ledger DEBIT, version incrementada', async () => {
    const { walletId, playerId } = await createWallet('100.00');

    const response = await submitBet(randomUUID(), {
      walletId,
      playerId,
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as SubmitBetBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(body.idempotentReplay).toBe(false);
    expect(body.failureCode).toBeUndefined();

    expect(await walletBalance(walletId)).toBe('75.00');
    expect(await countDebitLedgerEntries(walletId)).toBe(1);

    const wallets = (await orm.em
      .getConnection()
      .execute('SELECT version FROM wallets WHERE id = ?', [walletId])) as { version: number }[];
    expect(wallets[0].version).toBe(2);

    const ledger = (await orm.em
      .getConnection()
      .execute("SELECT direction, amount FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [
        walletId,
      ])) as { direction: string; amount: string }[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0].direction).toBe('DEBIT');
    expect(ledger[0].amount).toBe('25.00');
  });

  test('replay da mesma key e mesmo payload: mesmo transactionId, idempotentReplay true, nenhum novo ledger', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const key = randomUUID();
    // externalTransactionId fixo: sem isso, cada chamada a submitBet() geraria
    // um payload diferente (o helper sorteia um por padrao), o que faria a
    // "repeticao" na verdade ser um payload novo, nao um replay de verdade.
    const bet = { walletId, playerId, externalTransactionId: randomUUID(), money: { amount: '25.00', currency: 'BRL' } };

    const first = await submitBet(key, bet);
    const firstBody = (await first.json()) as SubmitBetBody;

    const second = await submitBet(key, bet);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as SubmitBetBody;

    expect(secondBody.transactionId).toBe(firstBody.transactionId);
    expect(secondBody.idempotentReplay).toBe(true);
    expect(secondBody.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    expect(await walletBalance(walletId)).toBe('75.00');
    expect(await countDebitLedgerEntries(walletId)).toBe(1);
  });

  test('mesma key com payload diferente: conflito, nenhum novo efeito financeiro', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const key = randomUUID();
    const externalTransactionId = randomUUID();

    await submitBet(key, { walletId, playerId, externalTransactionId, money: { amount: '25.00', currency: 'BRL' } });

    const conflicting = await submitBet(key, {
      walletId,
      playerId,
      externalTransactionId,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(conflicting.status).toBe(409);

    expect(await walletBalance(walletId)).toBe('75.00');
    expect(await countDebitLedgerEntries(walletId)).toBe(1);
  });

  test('saldo insuficiente: REJECTED/INSUFFICIENT_FUNDS, saldo intacto, nenhum ledger', async () => {
    const { walletId, playerId } = await createWallet('100.00');

    const response = await submitBet(randomUUID(), {
      walletId,
      playerId,
      money: { amount: '150.00', currency: 'BRL' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as SubmitBetBody;
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');

    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countDebitLedgerEntries(walletId)).toBe(0);
  });

  test('moeda divergente: REJECTED/CURRENCY_MISMATCH, saldo intacto, nenhum ledger', async () => {
    const { walletId, playerId } = await createWallet('100.00', 'BRL');

    const response = await submitBet(randomUUID(), {
      walletId,
      playerId,
      money: { amount: '25.00', currency: 'USD' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as SubmitBetBody;
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('CURRENCY_MISMATCH');

    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countDebitLedgerEntries(walletId)).toBe(0);
  });

  test('jogador divergente: REJECTED/PLAYER_MISMATCH, saldo intacto, nenhum ledger', async () => {
    const { walletId } = await createWallet('100.00');
    const someoneElse = randomUUID();

    const response = await submitBet(randomUUID(), {
      walletId,
      playerId: someoneElse,
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as SubmitBetBody;
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('PLAYER_MISMATCH');

    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countDebitLedgerEntries(walletId)).toBe(0);
  });

  test('wallet inexistente retorna 404, sem persistir nenhuma WagerTransaction', async () => {
    const response = await submitBet(randomUUID(), {
      walletId: randomUUID(),
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(response.status).toBe(404);

    const rows = (await orm.em.getConnection().execute('SELECT count(*)::int AS count FROM wager_transactions')) as {
      count: number;
    }[];
    expect(rows[0].count).toBe(0);
  });

  test('resposta original de uma BET PROCESSED continua estavel apos outra operacao mudar a wallet', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const keyOriginal = randomUUID();
    const bet = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      money: { amount: '25.00', currency: 'BRL' },
    };

    const original = await submitBet(keyOriginal, bet);
    const originalBody = (await original.json()) as SubmitBetBody;
    expect(originalBody.balance).toEqual({ amount: '75.00', currency: 'BRL' });

    // outra operacao muda a wallet depois
    await submitBet(randomUUID(), { walletId, playerId, money: { amount: '10.00', currency: 'BRL' } });
    expect(await walletBalance(walletId)).toBe('65.00');

    const replay = await submitBet(keyOriginal, bet);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as SubmitBetBody;
    expect(replayBody.idempotentReplay).toBe(true);
    // continua devolvendo o saldo observado na BET original (75.00), nao o saldo atual (65.00).
    expect(replayBody.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  test('resposta original de uma BET REJECTED continua estavel apos outra operacao mudar a wallet', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const keyRejected = randomUUID();
    const bet = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      money: { amount: '150.00', currency: 'BRL' },
    };

    const rejected = await submitBet(keyRejected, bet);
    const rejectedBody = (await rejected.json()) as SubmitBetBody;
    expect(rejectedBody.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(rejectedBody.failureCode).toBe('INSUFFICIENT_FUNDS');

    // outra operacao muda a wallet depois
    await submitBet(randomUUID(), { walletId, playerId, money: { amount: '30.00', currency: 'BRL' } });
    expect(await walletBalance(walletId)).toBe('70.00');

    const replay = await submitBet(keyRejected, bet);
    expect(replay.status).toBe(422);
    const replayBody = (await replay.json()) as SubmitBetBody;
    expect(replayBody.idempotentReplay).toBe(true);
    // continua devolvendo o saldo observado na rejeicao original (100.00), nao o saldo atual (70.00).
    expect(replayBody.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    // e o mesmo failureCode original.
    expect(replayBody.failureCode).toBe('INSUFFICIENT_FUNDS');
  });
});
