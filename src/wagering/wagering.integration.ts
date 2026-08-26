import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';

/**
 * Teste de integracao real: WIN, LOSS, REFUND, ROLLBACK e PENDING_REFERENCE
 * (Bloco 7a). Sobe a aplicacao Nest inteira e chama os endpoints HTTP via
 * fetch. Roda contra um banco local/descartavel: o afterEach faz TRUNCATE
 * nas tres tabelas funcionais entre testes.
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
  await orm.em.getConnection().execute('TRUNCATE TABLE wallet_ledger_entries, wager_transactions, wallets');
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
  status: string;
  balance?: { amount: string; currency: string };
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

async function countDebitLedgerEntries(walletId: string): Promise<number> {
  const rows = (await orm.em
    .getConnection()
    .execute(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    )) as { count: number }[];
  return rows[0].count;
}

async function countCreditLedgerEntries(walletId: string, excludeOpening = true): Promise<number> {
  const sql = excludeOpening
    ? `SELECT count(*)::int AS count FROM wallet_ledger_entries le
       JOIN wager_transactions wt ON wt.id = le.transaction_id
       WHERE le.wallet_id = ? AND le.direction = 'CREDIT' AND wt.kind <> 'OPENING'`
    : "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'";
  const rows = (await orm.em.getConnection().execute(sql, [walletId])) as { count: number }[];
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

async function processBet(walletId: string, playerId: string, amount: string): Promise<string> {
  const response = await submitWager(randomUUID(), {
    walletId,
    playerId,
    externalTransactionId: randomUUID(),
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  });
  const body = (await response.json()) as SubmitBody;
  return body.transactionId;
}

describe('POST /wagering/transactions — WIN, LOSS, REFUND, ROLLBACK (integracao real com Postgres)', () => {
  test('WIN sem referencia credita normalmente', async () => {
    const { walletId, playerId } = await createWallet('100.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'WIN',
      money: { amount: '40.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '140.00', currency: 'BRL' });
    expect(await walletBalance(walletId)).toBe('140.00');
  });

  test('WIN com referencia valida credita mesmo com valor diferente da BET', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    // saldo agora 90.00

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'WIN',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '500.00', currency: 'BRL' }, // premio bem maior que a aposta
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '590.00', currency: 'BRL' });
  });

  test('WIN com referencia de kind errado: REJECTED/INVALID_REFERENCE', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const lossExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: lossExternalId,
      kind: 'LOSS',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'WIN',
      referenceExternalTransactionId: lossExternalId,
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INVALID_REFERENCE');
    expect(await walletBalance(walletId)).toBe('100.00');
  });

  test('WIN com referencia inexistente vira PENDING_REFERENCE (202), sem tocar wallet/ledger', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const key = randomUUID();
    // externalTransactionId fixo: sem isso, o helper sorteia um novo a cada
    // chamada, e a "repeticao" mudaria o payloadHash (viraria conflito, nao replay).
    const payload = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'WIN',
      referenceExternalTransactionId: 'ext-que-nao-existe',
      money: { amount: '10.00', currency: 'BRL' },
    };

    const response = await submitWager(key, payload);

    expect(response.status).toBe(202);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PENDING_REFERENCE');
    expect(body.balance).toBeUndefined();
    expect(body.failureCode).toBeUndefined();
    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countCreditLedgerEntries(walletId)).toBe(0);

    // replay enquanto ainda pendente: mesmo 202, idempotentReplay true, sem balance/failureCode.
    const replay = await submitWager(key, payload);
    expect(replay.status).toBe(202);
    const replayBody = (await replay.json()) as SubmitBody;
    expect(replayBody.transactionId).toBe(body.transactionId);
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.balance).toBeUndefined();
    expect(replayBody.failureCode).toBeUndefined();
  });

  test('LOSS nao mexe em saldo nem ledger', async () => {
    const { walletId, playerId } = await createWallet('100.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'LOSS',
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countDebitLedgerEntries(walletId)).toBe(0);
    expect(await countCreditLedgerEntries(walletId)).toBe(0);
  });

  test('REFUND reverte uma BET PROCESSED e restaura o saldo', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(await walletBalance(walletId)).toBe('70.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await walletBalance(walletId)).toBe('100.00');
  });

  test('REFUND com referencia de kind errado (WIN): REJECTED/INVALID_REFERENCE', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const winExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: winExternalId,
      kind: 'WIN',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'REFUND',
      referenceExternalTransactionId: winExternalId,
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as SubmitBody;
    expect(body.failureCode).toBe('INVALID_REFERENCE');
  });

  test('REFUND duplicado sobre a mesma BET: segundo REJECTED/REFERENCE_ALREADY_REVERSED', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    const first = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(first.status).toBe(201);
    expect(await walletBalance(walletId)).toBe('100.00');

    const second = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(second.status).toBe(422);
    const secondBody = (await second.json()) as SubmitBody;
    expect(secondBody.status).toBe('REJECTED');
    expect(secondBody.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    // nao muda saldo de novo.
    expect(await walletBalance(walletId)).toBe('100.00');
  });

  test('REFUND com referencia inexistente vira PENDING_REFERENCE', async () => {
    const { walletId, playerId } = await createWallet('100.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-que-nao-existe',
      money: { amount: '10.00', currency: 'BRL' },
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PENDING_REFERENCE');
    expect(await walletBalance(walletId)).toBe('100.00');
  });

  test('ROLLBACK de uma BET credita de volta (inverso do debito)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    });
    expect(await walletBalance(walletId)).toBe('60.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '40.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('ROLLBACK de um WIN debita de volta (inverso do credito)', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const winExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: winExternalId,
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(await walletBalance(walletId)).toBe('150.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: winExternalId,
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('ROLLBACK que deixaria saldo negativo: REJECTED/REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE', async () => {
    const { walletId, playerId } = await createWallet('20.00');
    const winExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: winExternalId,
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(await walletBalance(walletId)).toBe('70.00');

    // gasta a maior parte do saldo antes de tentar o rollback do WIN.
    await processBet(walletId, playerId, '60.00');
    expect(await walletBalance(walletId)).toBe('10.00');

    const response = await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: winExternalId,
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE');
    expect(await walletBalance(walletId)).toBe('10.00');
  });

  test('replay de um REFUND nao duplica o credito', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();
    const key = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    const refundPayload = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '30.00', currency: 'BRL' },
    };

    const first = await submitWager(key, refundPayload);
    expect(first.status).toBe(201);
    expect(await walletBalance(walletId)).toBe('100.00');

    const second = await submitWager(key, refundPayload);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as SubmitBody;
    expect(secondBody.idempotentReplay).toBe(true);
    expect(await walletBalance(walletId)).toBe('100.00');
    expect(await countCreditLedgerEntries(walletId)).toBe(1);
  });

  test('credito que ultrapassa NUMERIC(19,2): REJECTED/BALANCE_LIMIT_EXCEEDED, sem alterar wallet nem criar ledger, replay identico', async () => {
    const { walletId, playerId } = await createWallet('99999999999999999.00');
    const key = randomUUID();
    const payload = {
      walletId,
      playerId,
      externalTransactionId: randomUUID(),
      kind: 'WIN',
      money: { amount: '1.00', currency: 'BRL' },
    };

    const response = await submitWager(key, payload);

    expect(response.status).toBe(422);
    const body = (await response.json()) as SubmitBody;
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await walletBalance(walletId)).toBe('99999999999999999.00');
    expect(await countCreditLedgerEntries(walletId)).toBe(0);

    // replay identico (mesma key, mesmo payload) devolve o mesmo resultado historico.
    const replay = await submitWager(key, payload);
    expect(replay.status).toBe(422);
    const replayBody = (await replay.json()) as SubmitBody;
    expect(replayBody.transactionId).toBe(body.transactionId);
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.status).toBe('REJECTED');
    expect(replayBody.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(replayBody.balance).toEqual({ amount: '99999999999999999.00', currency: 'BRL' });
    expect(await walletBalance(walletId)).toBe('99999999999999999.00');
  });

  test('saldo reconstruido pelo ledger bate com o saldo da wallet apos uma sequencia de operacoes', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const betExternalId = randomUUID();

    await submitWager(randomUUID(), {
      walletId,
      playerId,
      externalTransactionId: betExternalId,
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    });
    await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'WIN',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '80.00', currency: 'BRL' },
    });
    await submitWager(randomUUID(), {
      walletId,
      playerId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: betExternalId,
      money: { amount: '40.00', currency: 'BRL' },
    });

    const currentBalance = await walletBalance(walletId);
    const ledgerBalance = await reconstructedBalance(walletId);
    expect(ledgerBalance).toBe(currentBalance);
  });
});
