import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { OpenWalletUseCase } from '../wallets/open-wallet.use-case';
import { processWagerTransactionMessage } from './process-wager-transaction-message';

/**
 * Teste de concorrencia real: duas "instancias" do consumidor SQS (Bloco
 * 9b.1) recebendo, ao mesmo tempo, uma redelivery da MESMA messageId — o
 * cenario real de "visibility timeout expirou enquanto a primeira ainda
 * processava, o SQS entregou de novo para outro worker".
 *
 * Cada chamada recebe seu PROPRIO EntityManager (orm.em.fork()), cada um com
 * sua propria conexao/transacao — nao e um Promise.all compartilhando o
 * mesmo `em`, que nao provaria independencia nenhuma. A garantia de
 * exclusao mutua e o INSERT ... ON CONFLICT sobre a PK composta do Inbox no
 * Postgres, nunca um lock de aplicacao.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:concurrency`.
 */

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterEach(async () => {
  await orm.em
    .getConnection()
    .execute('TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets');
});

afterAll(async () => {
  await orm.close();
});

async function createWallet(initialAmount: string): Promise<{ walletId: string; playerId: string }> {
  const em = orm.em.fork();
  const playerId = randomUUID();
  const useCase = new OpenWalletUseCase(em);
  const result = await useCase.execute(
    { playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } },
    randomUUID(),
  );
  return { walletId: result.id, playerId };
}

function buildEnvelope(walletId: string, playerId: string, externalTransactionId: string, messageId: string): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: randomUUID(),
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  });
}

async function processWithOwnConnection(rawBody: string) {
  const em = orm.em.fork();
  return em.transactional((trxEm) => processWagerTransactionMessage(trxEm, rawBody));
}

async function walletBalance(walletId: string): Promise<string> {
  const rows = await orm.em
    .getConnection()
    .execute<{ balance_amount: string }[]>('SELECT balance_amount FROM wallets WHERE id = ?', [walletId]);
  return rows[0].balance_amount;
}

async function countDebitLedgerEntries(walletId: string): Promise<number> {
  const rows = await orm.em
    .getConnection()
    .execute<{ count: number }[]>(
      "SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [walletId],
    );
  return rows[0].count;
}

describe('Concorrencia real: duas entregas simultaneas da mesma messageId (Bloco 9b.1)', () => {
  test('exatamente uma processa de verdade; a outra recebe duplicate — repetido 6x para determinismo', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { walletId, playerId } = await createWallet('100.00');
      const externalTransactionId = randomUUID();
      const messageId = randomUUID();
      const envelope = buildEnvelope(walletId, playerId, externalTransactionId, messageId);

      const [resultA, resultB] = await Promise.all([processWithOwnConnection(envelope), processWithOwnConnection(envelope)]);

      const results = [resultA, resultB].sort();
      expect(results).toEqual(['duplicate', 'processed']);

      expect(await walletBalance(walletId)).toBe('75.00'); // debitado exatamente uma vez
      expect(await countDebitLedgerEntries(walletId)).toBe(1);
    }
  });
});
