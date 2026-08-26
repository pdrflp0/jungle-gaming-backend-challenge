import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';

/**
 * Verificacao reproduzivel do schema contra um PostgreSQL real.
 * Nao e descoberto pelo `bun test` (nao termina em .spec.ts/.test.ts e
 * fica fora de src/). Roda com `bun run db:verify`, exige o Postgres
 * do docker-compose no ar com a migration ja aplicada.
 */

let failures = 0;

async function expectRejected(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.error(`FALHOU (deveria ter sido rejeitado): ${label}`);
    failures += 1;
  } catch {
    console.log(`OK — rejeitado como esperado: ${label}`);
  }
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  const conn = orm.em.getConnection();

  const walletId = '00000000-0000-0000-0000-000000000001';
  const playerId = '00000000-0000-0000-0000-000000000002';
  const betId = '00000000-0000-0000-0000-000000000010';
  const ledgerId = '00000000-0000-0000-0000-000000000021';

  // fixtures validas usadas pelos casos abaixo
  await conn.execute(
    `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', '100.00', 1, now(), now())`,
    [walletId, playerId],
  );

  await conn.execute(
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       status, created_at, processed_at
     ) VALUES (?, 'provider-a', 'ext-bet', 'provider-a:ext-bet', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '25.00', 'BRL', 'PROCESSED', now(), now())`,
    [betId, walletId, playerId],
  );

  await conn.execute(
    `INSERT INTO wallet_ledger_entries (
       id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
     ) VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '75.00', now())`,
    [ledgerId, walletId, betId],
  );

  // 1. saldo negativo
  await expectRejected('saldo negativo', () =>
    conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', '-1.00', 1, now(), now())`,
      ['00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000098'],
    ),
  );

  // 2. wallet duplicada (mesmo player + moeda)
  await expectRejected('wallet duplicada (player + moeda)', () =>
    conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', '0.00', 1, now(), now())`,
      ['00000000-0000-0000-0000-000000000097', playerId],
    ),
  );

  // 3. moeda divergente entre transacao e wallet (FK composta wallet_id+currency)
  await expectRejected('moeda divergente entre transacao e wallet', () =>
    conn.execute(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         status, created_at
       ) VALUES (?, 'provider-a', 'ext-bad-currency', 'provider-a:ext-bad-currency', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'USD', 'PENDING', now())`,
      ['00000000-0000-0000-0000-000000000011', walletId, playerId],
    ),
  );

  // 4. ledger aritmeticamente incorreto (deveria ser 75.00, nao 80.00)
  await expectRejected('ledger com aritmetica incorreta', () =>
    conn.execute(
      `INSERT INTO wallet_ledger_entries (
         id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
       ) VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '80.00', now())`,
      ['00000000-0000-0000-0000-000000000020', walletId, betId],
    ),
  );

  // 5. UPDATE no ledger (append-only via trigger)
  await expectRejected('UPDATE no ledger', () =>
    conn.execute(`UPDATE wallet_ledger_entries SET amount = '30.00' WHERE id = ?`, [ledgerId]),
  );

  // 6. DELETE no ledger (append-only via trigger)
  await expectRejected('DELETE no ledger', () =>
    conn.execute(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [ledgerId]),
  );

  // 7. transacao duplicada por provider + externalTransactionId
  await expectRejected('transacao duplicada (provider + externalTransactionId)', () =>
    conn.execute(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         status, created_at
       ) VALUES (?, 'provider-a', 'ext-bet', 'provider-a:ext-bet-dup', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PENDING', now())`,
      ['00000000-0000-0000-0000-000000000012', walletId, playerId],
    ),
  );

  // 8. idempotencyKey duplicada
  await expectRejected('idempotencyKey duplicada', () =>
    conn.execute(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         status, created_at
       ) VALUES (?, 'provider-b', 'ext-other', 'provider-a:ext-bet', 'hash', ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PENDING', now())`,
      ['00000000-0000-0000-0000-000000000013', walletId, playerId],
    ),
  );

  await orm.close();

  if (failures > 0) {
    console.error(`\nVerificacao FALHOU: ${failures} constraint(s) nao rejeitaram uma entrada invalida.`);
    process.exit(1);
  }

  console.log('\nTodas as constraints rejeitaram corretamente as entradas invalidas.');
}

main().catch((error) => {
  console.error('Erro inesperado ao verificar o banco:', error);
  process.exit(1);
});
