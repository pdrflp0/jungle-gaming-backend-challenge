import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';
import { RetryPendingReferenceWorker } from './retry-pending-reference.worker';

/**
 * Teste de integracao real do worker de reprocessamento de PENDING_REFERENCE
 * (Bloco 7b). Sobe a aplicacao Nest inteira (o @Interval do worker existe,
 * mas fica desligado por padrao — ver retry-pending-reference.worker.ts) e
 * chama `processDueOnce`/`processDueBatch` diretamente, nunca esperando o
 * timer real de 3s.
 *
 * Sem sufixo .spec./.test. de proposito — nao entra no `bun test` padrao.
 * Roda so via `bun run test:integration`.
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
  await orm.em.getConnection().execute('TRUNCATE TABLE wallet_ledger_entries, wager_transactions, wallets');
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

interface Wallet {
  walletId: string;
  playerId: string;
}

async function createWallet(initialAmount: string): Promise<Wallet> {
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

async function countCreditLedgerEntries(walletId: string): Promise<number> {
  const rows = (await orm.em.getConnection().execute(
    `SELECT count(*)::int AS count FROM wallet_ledger_entries le
     JOIN wager_transactions wt ON wt.id = le.transaction_id
     WHERE le.wallet_id = ? AND le.direction = 'CREDIT' AND wt.kind <> 'OPENING'`,
    [walletId],
  )) as { count: number }[];
  return rows[0].count;
}

async function reconstructedBalance(walletId: string): Promise<string> {
  const rows = (await orm.em.getConnection().execute(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total
     FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  )) as { total: string }[];
  return Number(rows[0].total).toFixed(2);
}

async function retryState(transactionId: string): Promise<{
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  dbNow: Date;
}> {
  const rows = (await orm.em.getConnection().execute(
    'SELECT status, attempts, next_attempt_at, now() AS db_now FROM wager_transactions WHERE id = ?',
    [transactionId],
  )) as { status: string; attempts: number; next_attempt_at: string | Date | null; db_now: string | Date }[];
  return {
    status: rows[0].status,
    attempts: rows[0].attempts,
    // O driver pode devolver timestamptz cru como string em consultas raw
    // (fora da hidratacao normal do MikroORM) — normaliza para Date aqui.
    nextAttemptAt: rows[0].next_attempt_at ? new Date(rows[0].next_attempt_at) : null,
    dbNow: new Date(rows[0].db_now),
  };
}

async function fetchTerminalDetails(transactionId: string): Promise<{
  status: string;
  failureCode: string | null;
  resultBalanceAmount: string | null;
  resultBalanceCurrency: string | null;
  nextAttemptAt: Date | null;
}> {
  const rows = (await orm.em.getConnection().execute(
    `SELECT status, failure_code, result_balance_amount, result_balance_currency, next_attempt_at
     FROM wager_transactions WHERE id = ?`,
    [transactionId],
  )) as {
    status: string;
    failure_code: string | null;
    result_balance_amount: string | null;
    result_balance_currency: string | null;
    next_attempt_at: string | Date | null;
  }[];
  return {
    status: rows[0].status,
    failureCode: rows[0].failure_code,
    resultBalanceAmount: rows[0].result_balance_amount,
    resultBalanceCurrency: rows[0].result_balance_currency,
    nextAttemptAt: rows[0].next_attempt_at ? new Date(rows[0].next_attempt_at) : null,
  };
}

async function countAllLedgerEntries(walletId: string): Promise<number> {
  const rows = (await orm.em
    .getConnection()
    .execute('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ?', [
      walletId,
    ])) as { count: number }[];
  return rows[0].count;
}

/** Simula o TTL estourado sem esperar 30 minutos reais nem mudar os parametros de producao. */
async function backdateCreatedAt(transactionId: string, minutesAgo: number): Promise<void> {
  await orm.em
    .getConnection()
    .execute("UPDATE wager_transactions SET created_at = now() - make_interval(mins => ?) WHERE id = ?", [
      minutesAgo,
      transactionId,
    ]);
}

describe('Worker de reprocessamento de PENDING_REFERENCE (Bloco 7b, integracao real)', () => {
  test('REFUND chega antes da BET: fica pendente, a BET chega, o worker resolve exatamente uma vez', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    const refundKey = randomUUID();
    const refundPayload = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '30.00', currency: 'BRL' },
    };

    const pending = await submitWager(refundKey, refundPayload);
    expect(pending.status).toBe(202);
    const pendingBody = (await pending.json()) as SubmitBody;
    expect(pendingBody.status).toBe('PENDING_REFERENCE');

    // replay enquanto ainda pendente: 202, sem balance/failureCode inventados.
    const replayWhilePending = await submitWager(refundKey, refundPayload);
    expect(replayWhilePending.status).toBe(202);
    const replayWhilePendingBody = (await replayWhilePending.json()) as SubmitBody;
    expect(replayWhilePendingBody.idempotentReplay).toBe(true);
    expect(replayWhilePendingBody.balance).toBeUndefined();
    expect(replayWhilePendingBody.failureCode).toBeUndefined();

    // a BET referenciada chega agora.
    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(await walletBalance(walletId)).toBe('70.00');

    const processedCount = await worker.processDueBatch();
    expect(processedCount).toBe(1);

    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countCreditLedgerEntries(walletId)).toBe(1);
    expect(await reconstructedBalance(walletId)).toBe(await walletBalance(walletId));

    // rodar o worker de novo nao acha mais nada devido (ja terminal).
    expect(await worker.processDueBatch()).toBe(0);

    // replay depois do worker: devolve o resultado terminal verdadeiro, nao inventado.
    const replayAfterWorker = await submitWager(refundKey, refundPayload);
    expect(replayAfterWorker.status).toBe(200);
    const replayAfterWorkerBody = (await replayAfterWorker.json()) as SubmitBody;
    expect(replayAfterWorkerBody.idempotentReplay).toBe(true);
    expect(replayAfterWorkerBody.status).toBe('PROCESSED');
    expect(replayAfterWorkerBody.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('ROLLBACK chega antes da BET: fica pendente, a BET chega, o worker resolve exatamente uma vez', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    const rollbackKey = randomUUID();
    const rollbackPayload = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'ROLLBACK',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '40.00', currency: 'BRL' },
    };

    const pending = await submitWager(rollbackKey, rollbackPayload);
    expect(pending.status).toBe(202);

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    });
    expect(await walletBalance(walletId)).toBe('60.00');

    expect(await worker.processDueBatch()).toBe(1);

    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countCreditLedgerEntries(walletId)).toBe(1);
    expect(await reconstructedBalance(walletId)).toBe(await walletBalance(walletId));

    const replayAfterWorker = await submitWager(rollbackKey, rollbackPayload);
    expect(replayAfterWorker.status).toBe(200);
    const body = (await replayAfterWorker.json()) as SubmitBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('ROLLBACK referenciando um WIN que ainda esta PENDING_REFERENCE nao rejeita antes da hora', async () => {
    // Cenario que expos a falha real do Bloco 7a: a validacao de referencia
    // so sabia dizer "PROCESSED" ou "invalida" — uma referencia encontrada
    // mas ainda PENDING_REFERENCE caia no "invalida" e rejeitava para
    // sempre, mesmo podendo se tornar valida.
    const { walletId, playerId } = await createWallet('100.00');
    const winExternalId = randomUUID();
    const betExternalId = randomUUID();

    const rollback = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'ROLLBACK',
      referenceExternalTransactionId: winExternalId,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(rollback.status).toBe(202);
    const { transactionId: rollbackId } = (await rollback.json()) as SubmitBody;

    // o WIN chega, mas ele mesmo referencia uma BET que ainda nao chegou —
    // fica PENDING_REFERENCE, nao PROCESSED.
    const win = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: winExternalId,
      kind: 'WIN',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(win.status).toBe(202);

    // se o worker rodasse a validacao antiga, o ROLLBACK seria REJECTED
    // aqui, permanentemente, so porque encontrou o WIN (ainda nao PROCESSED).
    // O correto e continuar esperando.
    await worker.processDueBatch();
    expect((await retryState(rollbackId)).status).toBe('PENDING_REFERENCE');

    // agora a BET chega: o WIN pode se resolver, e so depois o ROLLBACK.
    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(await walletBalance(walletId)).toBe('90.00');

    // a resolucao da cadeia pode exigir mais de uma passada (o ROLLBACK so
    // pode resolver DEPOIS que o WIN resolver) — por isso forca as linhas
    // ainda pendentes a ficarem devidas de novo a cada volta, sem esperar o
    // backoff real, ate nao sobrar nada para processar.
    for (let i = 0; i < 5; i += 1) {
      await orm.em
        .getConnection()
        .execute("UPDATE wager_transactions SET next_attempt_at = now() WHERE status = 'PENDING_REFERENCE'");
      const processed = await worker.processDueBatch();
      if (processed === 0) {
        break;
      }
    }

    expect((await retryState(rollbackId)).status).toBe('PROCESSED');
    // 100 - 10 (BET) + 50 (WIN) - 50 (ROLLBACK do WIN) = 90
    expect(await walletBalance(walletId)).toBe('90.00');
    expect(await reconstructedBalance(walletId)).toBe('90.00');
  });

  test('referencia que nunca chega expira pelo TTL: REJECTED/REFERENCE_NOT_FOUND', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const key = randomUUID();
    const payload = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'nunca-vai-chegar',
      money: { amount: '10.00', currency: 'BRL' },
    };

    const response = await submitWager(key, payload);
    expect(response.status).toBe(202);
    const { transactionId } = (await response.json()) as SubmitBody;

    // so a OPENING gerou lancamento ate aqui — nada mais pode ser criado por
    // uma transacao que nunca chega a mexer em saldo.
    const ledgerCountBefore = await countAllLedgerEntries(walletId);
    expect(ledgerCountBefore).toBe(1);

    // simula os 30 minutos de TTL passando, sem esperar de verdade.
    await backdateCreatedAt(transactionId, 31);

    expect(await worker.processDueBatch()).toBe(1);

    const details = await fetchTerminalDetails(transactionId);
    expect(details.status).toBe('REJECTED');
    expect(details.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(details.resultBalanceAmount).toBe('100.00');
    expect(details.resultBalanceCurrency).toBe('BRL');
    expect(details.nextAttemptAt).toBeNull();
    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countAllLedgerEntries(walletId)).toBe(ledgerCountBefore);

    // reenvia exatamente a mesma Idempotency-Key e o mesmo payload depois da
    // expiracao: replay do resultado terminal verdadeiro, nada inventado.
    const replay = await submitWager(key, payload);
    expect(replay.status).toBe(422);
    const replayBody = (await replay.json()) as SubmitBody;
    expect(replayBody.transactionId).toBe(transactionId);
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.status).toBe('REJECTED');
    expect(replayBody.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(replayBody.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countAllLedgerEntries(walletId)).toBe(ledgerCountBefore);
  });

  test('backoff: attempts e next_attempt_at avancam a cada tentativa sem resolver', async () => {
    const { walletId, playerId } = await createWallet('100.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'WIN',
      referenceExternalTransactionId: 'ainda-nao-chegou',
      money: { amount: '10.00', currency: 'BRL' },
    });
    const { transactionId } = (await response.json()) as SubmitBody;

    const initial = await retryState(transactionId);
    expect(initial.attempts).toBe(0);

    // primeira tentativa do worker: devida imediatamente desde a criacao —
    // so a PARTIR da primeira tentativa falha e que o backoff entra em jogo.
    expect(await worker.processDueOnce()).toBe(true);

    const afterFirstRetry = await retryState(transactionId);
    expect(afterFirstRetry.status).toBe('PENDING_REFERENCE');
    expect(afterFirstRetry.attempts).toBe(1);
    expect(afterFirstRetry.nextAttemptAt).not.toBeNull();
    const firstDelaySeconds = (afterFirstRetry.nextAttemptAt!.getTime() - afterFirstRetry.dbNow.getTime()) / 1000;
    expect(firstDelaySeconds).toBeGreaterThan(3);
    expect(firstDelaySeconds).toBeLessThan(7); // esperado 5s

    // forca a segunda tentativa a ficar devida agora, sem esperar o backoff real.
    await orm.em.getConnection().execute('UPDATE wager_transactions SET next_attempt_at = now() WHERE id = ?', [
      transactionId,
    ]);
    expect(await worker.processDueOnce()).toBe(true);

    const afterSecondRetry = await retryState(transactionId);
    expect(afterSecondRetry.attempts).toBe(2);
    const secondDelaySeconds = (afterSecondRetry.nextAttemptAt!.getTime() - afterSecondRetry.dbNow.getTime()) / 1000;
    expect(secondDelaySeconds).toBeGreaterThan(8);
    expect(secondDelaySeconds).toBeLessThan(12); // esperado 10s (dobrou)
  });

  test('processDueBatch resolve mais de uma linha devida numa unica chamada', async () => {
    const walletA = await createWallet('100.00');
    const walletB = await createWallet('100.00');
    const betA = randomUUID();
    const betB = randomUUID();

    await submitWager(randomUUID(), {
      walletId: walletA.walletId,
      playerId: walletA.playerId,
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      referenceExternalTransactionId: betA,
      money: { amount: '10.00', currency: 'BRL' },
    });
    await submitWager(randomUUID(), {
      walletId: walletB.walletId,
      playerId: walletB.playerId,
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      referenceExternalTransactionId: betB,
      money: { amount: '10.00', currency: 'BRL' },
    });

    await submitWager(randomUUID(), {
      walletId: walletA.walletId,
      playerId: walletA.playerId,
      externalTransactionId: betA,
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    await submitWager(randomUUID(), {
      walletId: walletB.walletId,
      playerId: walletB.playerId,
      externalTransactionId: betB,
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(await worker.processDueBatch()).toBe(2);
    expect(await walletBalance(walletA.walletId)).toBe('100.00');
    expect(await walletBalance(walletB.walletId)).toBe('100.00');
  });
});
