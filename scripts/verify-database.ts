import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Knex } from 'knex';
import config from '../mikro-orm.config';

/**
 * Verificacao reproduzivel do schema contra um PostgreSQL real.
 * Nao e descoberto pelo `bun test` (nao termina em .spec.ts/.test.ts e
 * fica fora de src/). Roda com `bun run db:verify`, exige o Postgres
 * do docker-compose no ar com a migration ja aplicada.
 *
 * Tudo roda dentro de UMA transacao externa que sempre sofre ROLLBACK
 * (sucesso ou erro) — nenhum dado fica persistido. Cada caso invalido
 * roda dentro de um SAVEPOINT proprio (via transacao aninhada do knex),
 * porque uma violacao de constraint aborta a transacao corrente no
 * Postgres; sem savepoint, o caso seguinte tambem falharia.
 */

let failures = 0;

class IntentionalRollback extends Error {}

function byConstraint(name: string) {
  return (error: unknown): boolean => (error as { constraint?: string })?.constraint === name;
}

function byMessage(text: string) {
  return (error: unknown): boolean =>
    typeof (error as { message?: unknown })?.message === 'string' &&
    (error as { message: string }).message.includes(text);
}

function describeError(error: unknown): string {
  const e = error as { code?: string; constraint?: string; message?: string };
  return `code=${e?.code ?? '?'} constraint=${e?.constraint ?? '?'} message=${e?.message ?? String(error)}`;
}

async function expectRejected(
  trx: Knex.Transaction,
  label: string,
  matches: (error: unknown) => boolean,
  run: (savepointTrx: Knex.Transaction) => Promise<unknown>,
): Promise<void> {
  try {
    await trx.transaction(run);
    console.error(`FALHOU (nao foi rejeitado): ${label}`);
    failures += 1;
  } catch (error) {
    if (matches(error)) {
      console.log(`OK — rejeitado como esperado: ${label}`);
    } else {
      console.error(`FALHOU (rejeitado pelo motivo errado): ${label} — ${describeError(error)}`);
      failures += 1;
    }
  }
}

async function runVerification(trx: Knex.Transaction): Promise<void> {
  const walletId = randomUUID();
  const playerId = randomUUID();
  const betId = randomUUID(); // tem ledger valido — usado nos testes de UPDATE/DELETE
  const secondBetId = randomUUID(); // PROCESSED, ainda sem ledger — usado so no teste de aritmetica

  await trx.raw(
    `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', '100.00', 1, now(), now())`,
    [walletId, playerId],
  );

  await trx.raw(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       status, created_at, processed_at, correlation_id
     ) VALUES (?, 'provider-a', 'ext-bet', 'provider-a:ext-bet', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '25.00', 'BRL', 'PROCESSED', now(), now(), 'correlation-verify')`,
    [betId, walletId, playerId],
  );

  await trx.raw(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       status, created_at, processed_at, correlation_id
     ) VALUES (?, 'provider-a', 'ext-bet-2', 'provider-a:ext-bet-2', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PROCESSED', now(), now(), 'correlation-verify')`,
    [secondBetId, walletId, playerId],
  );

  const ledgerId = randomUUID();
  await trx.raw(
    `INSERT INTO wallet_ledger_entries (
       id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
     ) VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '75.00', now())`,
    [ledgerId, walletId, betId],
  );

  await expectRejected(trx, 'saldo negativo', byConstraint('wallets_balance_non_negative'), (sp) =>
    sp.raw(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', '-1.00', 1, now(), now())`,
      [randomUUID(), randomUUID()],
    ),
  );

  await expectRejected(
    trx,
    'wallet duplicada (player + moeda)',
    byConstraint('wallets_player_currency_unique'),
    (sp) =>
      sp.raw(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (?, ?, 'BRL', '0.00', 1, now(), now())`,
        [randomUUID(), playerId],
      ),
  );

  // wager_transactions aceita moeda divergente de proposito (Bloco 6): uma BET
  // submetida numa moeda diferente da wallet precisa ser gravada e rejeitada
  // com failureCode CURRENCY_MISMATCH, nao barrada na hora de inserir. Quem
  // continua com FK composta de moeda e o ledger — nenhum lancamento real
  // pode ter moeda diferente da wallet.
  await expectRejected(
    trx,
    'moeda divergente entre ledger e wallet',
    byConstraint('wallet_ledger_entries_wallet_currency_fk'),
    (sp) =>
      sp.raw(
        `INSERT INTO wallet_ledger_entries (
           id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         ) VALUES (?, ?, ?, 'DEBIT', '10.00', 'USD', '100.00', '90.00', now())`,
        [randomUUID(), walletId, secondBetId],
      ),
  );

  // usa secondBetId (sem ledger ainda) para garantir que a rejeicao venha do CHECK
  // aritmetico, e nao de wallet_ledger_entries_wallet_transaction_unique.
  await expectRejected(
    trx,
    'ledger com aritmetica incorreta',
    byConstraint('wallet_ledger_entries_arithmetic'),
    (sp) =>
      sp.raw(
        `INSERT INTO wallet_ledger_entries (
           id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         ) VALUES (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '80.00', now())`, // deveria ser 90.00
        [randomUUID(), walletId, secondBetId],
      ),
  );

  await expectRejected(trx, 'UPDATE no ledger', byMessage('append-only'), (sp) =>
    sp.raw(`UPDATE wallet_ledger_entries SET amount = '30.00' WHERE id = ?`, [ledgerId]),
  );

  await expectRejected(trx, 'DELETE no ledger', byMessage('append-only'), (sp) =>
    sp.raw(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [ledgerId]),
  );

  await expectRejected(
    trx,
    'transacao duplicada (provider + externalTransactionId)',
    byConstraint('wager_transactions_provider_external_unique'),
    (sp) =>
      sp.raw(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency,
           status, created_at, correlation_id
         ) VALUES (?, 'provider-a', 'ext-bet', 'provider-a:ext-bet-dup', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PENDING', now(), 'correlation-verify')`,
        [randomUUID(), walletId, playerId],
      ),
  );

  await expectRejected(
    trx,
    'idempotencyKey duplicada',
    byConstraint('wager_transactions_idempotency_key_unique'),
    (sp) =>
      sp.raw(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency,
           status, created_at, correlation_id
         ) VALUES (?, 'provider-b', 'ext-other', 'provider-a:ext-bet', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PENDING', now(), 'correlation-verify')`,
        [randomUUID(), walletId, playerId],
      ),
  );

  // --- Bloco 9a.1: Inbox e Outbox --------------------------------------

  const outboxId = randomUUID();

  await trx.raw(
    `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at)
     VALUES ('msg-1', 'wager-transactions-consumer', 'hash-inbox', now())`,
  );
  console.log('OK — insercao valida aceita: inbox_messages');

  await trx.raw(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
     VALUES (?, ?, 'WagerTransactionProcessed', '{"eventId":"e1"}'::jsonb, now(), 0, now())`,
    [outboxId, betId],
  );
  console.log('OK — insercao valida aceita: outbox_messages');

  await expectRejected(
    trx,
    'inbox duplicada (consumerName + messageId)',
    byConstraint('inbox_messages_pkey'),
    (sp) =>
      sp.raw(
        `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at)
         VALUES ('msg-1', 'wager-transactions-consumer', 'hash-outra', now())`,
      ),
  );

  await expectRejected(
    trx,
    'outbox com attempts negativo',
    byConstraint('outbox_messages_attempts_non_negative'),
    (sp) =>
      sp.raw(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES (?, ?, 'WagerTransactionProcessed', '{}'::jsonb, now(), -1, now())`,
        [randomUUID(), betId],
      ),
  );

  await expectRejected(
    trx,
    'outbox pendente sem next_attempt_at',
    byConstraint('outbox_messages_next_attempt_consistency'),
    (sp) =>
      sp.raw(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
         VALUES (?, ?, 'WagerTransactionProcessed', '{}'::jsonb, now(), 0, NULL, NULL)`,
        [randomUUID(), betId],
      ),
  );

  await expectRejected(
    trx,
    'outbox publicada mantendo next_attempt_at preenchido',
    byConstraint('outbox_messages_next_attempt_consistency'),
    (sp) =>
      sp.raw(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
         VALUES (?, ?, 'WagerTransactionProcessed', '{}'::jsonb, now(), 0, now(), now())`,
        [randomUUID(), betId],
      ),
  );
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const knex = orm.em.getConnection().getKnex();

    try {
      await knex.transaction(async (trx) => {
        await runVerification(trx);
        // forca ROLLBACK da transacao externa mesmo quando tudo deu certo —
        // este script nunca deve persistir dado nenhum.
        throw new IntentionalRollback();
      });
    } catch (error) {
      if (!(error instanceof IntentionalRollback)) {
        throw error;
      }
    }
  } finally {
    await orm.close();
  }

  if (failures > 0) {
    console.error(`\nVerificacao FALHOU: ${failures} caso(s) nao se comportaram como esperado.`);
    process.exit(1);
  }

  console.log(
    '\nTodas as constraints rejeitaram corretamente as entradas invalidas (rollback aplicado, nada persistido).',
  );
}

main().catch((error) => {
  console.error('Erro inesperado ao verificar o banco:', error);
  process.exit(1);
});
