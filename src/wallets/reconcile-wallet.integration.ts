import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../app.module';
import { walletReconciliationDivergences } from '../observability/metrics';
import type { ReconciliationResponse } from './reconcile-wallet.use-case';

/**
 * Teste de integracao real de POST /wallets/:walletId/reconciliation
 * (Bloco 8b). Sobe a aplicacao Nest inteira e chama via fetch.
 *
 * A divergencia testada aqui e sempre provocada manualmente, via UPDATE
 * direto no banco dentro do proprio teste — o sistema real nunca produz uma
 * wallet divergente sozinho (essa e a invariante que os blocos anteriores
 * garantem); esta e a unica forma honesta de exercitar o caminho
 * "consistent: false" sem inventar um cenario fictício.
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

function reconcile(walletId: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST', headers });
}

async function corruptStoredBalance(walletId: string, amount: string): Promise<void> {
  await orm.em
    .getConnection()
    .execute('UPDATE wallets SET balance_amount = ? WHERE id = ?', [amount, walletId]);
}

async function walletRow(walletId: string): Promise<{ balance_amount: string; version: number; updated_at: Date }> {
  const rows = (await orm.em
    .getConnection()
    .execute('SELECT balance_amount, version, updated_at FROM wallets WHERE id = ?', [walletId])) as {
    balance_amount: string;
    version: number;
    updated_at: Date;
  }[];
  return rows[0];
}

async function countAll(): Promise<{ wallets: number; transactions: number; ledgerEntries: number }> {
  const conn = orm.em.getConnection();
  const [wallets] = await conn.execute('SELECT count(*)::int AS count FROM wallets');
  const [transactions] = await conn.execute('SELECT count(*)::int AS count FROM wager_transactions');
  const [ledgerEntries] = await conn.execute('SELECT count(*)::int AS count FROM wallet_ledger_entries');
  return { wallets: wallets.count, transactions: transactions.count, ledgerEntries: ledgerEntries.count };
}

async function divergenceCounterValue(currency: string): Promise<number> {
  const metric = await walletReconciliationDivergences.get();
  return metric.values.find((v) => v.labels.currency === currency)?.value ?? 0;
}

/** Substitui console.warn temporariamente, captura as linhas emitidas e restaura no final. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = ((...args: unknown[]) => {
    warnings.push(String(args[0]));
  }) as typeof console.warn;
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

describe('POST /wallets/:walletId/reconciliation (integracao real com Postgres)', () => {
  test('wallet sem lancamentos, saldo zero: consistent, checkedEntries=0, tudo "0.00"', async () => {
    const { walletId } = await createWallet('0.00');

    const response = await reconcile(walletId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReconciliationResponse;

    expect(body).toEqual({
      walletId,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('wallet com OPENING: checkedEntries=1, consistente', async () => {
    const { walletId } = await createWallet('1000.00');

    const response = await reconcile(walletId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReconciliationResponse;

    expect(body.storedBalance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(body.calculatedBalance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(body.consistent).toBe(true);
    expect(body.checkedEntries).toBe(1);
  });

  test('sequencia real de debitos e creditos: checkedEntries bate com a contagem real, consistente', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const betExternalId = randomUUID();

    await submitWager({ walletId, playerId, externalTransactionId: betExternalId, kind: 'BET', money: { amount: '100.00', currency: 'BRL' } });
    await submitWager({ walletId, playerId, kind: 'WIN', referenceExternalTransactionId: betExternalId, money: { amount: '50.00', currency: 'BRL' } });
    await submitWager({ walletId, playerId, kind: 'REFUND', referenceExternalTransactionId: betExternalId, money: { amount: '100.00', currency: 'BRL' } });

    const reference = (await orm.em
      .getConnection()
      .execute('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ?', [
        walletId,
      ])) as { count: number }[];

    const response = await reconcile(walletId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReconciliationResponse;

    // 1000 (OPENING) - 100 (BET) + 50 (WIN) + 100 (REFUND) = 1050
    expect(body.storedBalance).toEqual({ amount: '1050.00', currency: 'BRL' });
    expect(body.calculatedBalance).toEqual({ amount: '1050.00', currency: 'BRL' });
    expect(body.consistent).toBe(true);
    expect(body.checkedEntries).toBe(reference[0].count);
    expect(body.checkedEntries).toBe(4); // OPENING + BET + WIN + REFUND
  });

  test('divergencia provocada no teste (saldo armazenado maior que o reconstruido): consistent=false, difference positivo', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    await submitWager({ walletId, playerId, kind: 'BET', money: { amount: '30.00', currency: 'BRL' } });
    // saldo real: 70.00. Corrompe so a coluna de saldo, direto no banco —
    // nenhum caminho da aplicacao produz isso sozinho.
    await corruptStoredBalance(walletId, '9999.00');

    const before = await walletRow(walletId);

    const response = await reconcile(walletId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReconciliationResponse;

    expect(body.storedBalance).toEqual({ amount: '9999.00', currency: 'BRL' });
    expect(body.calculatedBalance).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(body.difference).toEqual({ amount: '9929.00', currency: 'BRL' });
    expect(body.consistent).toBe(false);

    // o endpoint nao corrige nada: saldo, version e updated_at continuam
    // exatamente como estavam antes da chamada de reconciliacao.
    const after = await walletRow(walletId);
    expect(after).toEqual(before);
  });

  test('divergencia com sinal invertido (saldo armazenado menor que o reconstruido): difference negativo', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    await submitWager({ walletId, playerId, kind: 'BET', money: { amount: '30.00', currency: 'BRL' } });
    // saldo real: 70.00. Corrompe para um valor MENOR que o reconstruido.
    await corruptStoredBalance(walletId, '10.00');

    const response = await reconcile(walletId);
    const body = (await response.json()) as ReconciliationResponse;

    expect(body.storedBalance).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(body.calculatedBalance).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(body.difference).toEqual({ amount: '-60.00', currency: 'BRL' });
    expect(body.consistent).toBe(false);
  });

  test('nenhuma mutacao causada pelo endpoint no caso consistente (saldo, ledger, transacoes)', async () => {
    const { walletId, playerId } = await createWallet('300.00');
    await submitWager({ walletId, playerId, kind: 'BET', money: { amount: '50.00', currency: 'BRL' } });

    const before = await countAll();
    const walletBefore = await walletRow(walletId);

    await reconcile(walletId);
    await reconcile(walletId);

    const after = await countAll();
    const walletAfter = await walletRow(walletId);

    expect(after).toEqual(before);
    expect(walletAfter).toEqual(walletBefore);
  });

  test('contador nao muda no caso consistente', async () => {
    const { walletId } = await createWallet('100.00');

    const before = await divergenceCounterValue('BRL');
    const response = await reconcile(walletId);
    expect((await response.json() as ReconciliationResponse).consistent).toBe(true);
    const after = await divergenceCounterValue('BRL');

    expect(after).toBe(before);
  });

  test('contador incrementa em exatamente 1 no caso divergente', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    await submitWager({ walletId, playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } });
    await corruptStoredBalance(walletId, '500.00');

    const before = await divergenceCounterValue('BRL');
    const response = await reconcile(walletId);
    expect((await response.json() as ReconciliationResponse).consistent).toBe(false);
    const after = await divergenceCounterValue('BRL');

    expect(after - before).toBe(1);
  });

  test('log de divergencia: JSON valido, com correlationId e walletId, sem nenhum valor monetario', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    await submitWager({ walletId, playerId, kind: 'BET', money: { amount: '10.00', currency: 'BRL' } });
    await corruptStoredBalance(walletId, '500.00');

    const { result: response, warnings } = await captureWarnings(() => reconcile(walletId));
    expect(response.status).toBe(200);
    expect(warnings).toHaveLength(1);

    const logged = JSON.parse(warnings[0]) as Record<string, unknown>;
    expect(logged.event).toBe('wallet_reconciliation_divergence');
    expect(logged.level).toBe('warn');
    expect(typeof logged.timestamp).toBe('string');
    expect(typeof logged.correlationId).toBe('string');
    expect(logged.walletId).toBe(walletId);
    expect(logged.currency).toBe('BRL');
    expect(logged.checkedEntries).toBe(2);
    expect(logged.consistent).toBe(false);

    // nunca inclui valores monetarios nem qualquer chave com saldo/diferenca.
    expect(logged).not.toHaveProperty('storedBalance');
    expect(logged).not.toHaveProperty('calculatedBalance');
    expect(logged).not.toHaveProperty('difference');
    expect(logged).not.toHaveProperty('playerId');
    expect(logged).not.toHaveProperty('payload');
  });

  test('nao gera log quando a reconciliacao e consistente', async () => {
    const { walletId } = await createWallet('100.00');

    const { warnings } = await captureWarnings(() => reconcile(walletId));
    expect(warnings).toHaveLength(0);
  });

  test('X-Correlation-Id recebido do cliente e devolvido identico', async () => {
    const { walletId } = await createWallet('100.00');
    const myCorrelationId = 'req-abc-123';

    const response = await reconcile(walletId, { 'x-correlation-id': myCorrelationId });
    expect(response.headers.get('x-correlation-id')).toBe(myCorrelationId);
  });

  test('correlationId e gerado quando o header esta ausente', async () => {
    const { walletId } = await createWallet('100.00');

    const response = await reconcile(walletId);
    const generated = response.headers.get('x-correlation-id');
    expect(generated).toBeTruthy();
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('correlationId invalido no header e substituido por um gerado, sem rejeitar a requisicao', async () => {
    const { walletId } = await createWallet('100.00');

    const response = await reconcile(walletId, { 'x-correlation-id': 'valor com espaco invalido' });
    expect(response.status).toBe(200);
    const generated = response.headers.get('x-correlation-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('uuid malformado no path retorna 400', async () => {
    const response = await reconcile('nao-e-um-uuid');
    expect(response.status).toBe(400);
  });

  test('wallet inexistente retorna 404', async () => {
    const response = await reconcile(randomUUID());
    expect(response.status).toBe(404);
  });
});
