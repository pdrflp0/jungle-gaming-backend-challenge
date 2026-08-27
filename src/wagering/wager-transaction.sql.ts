import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../domain/money/money';
import { Wallet } from '../domain/wallet/wallet';
import { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction';

/**
 * Todo o acesso a dados deste fluxo e SQL explicito, sem em.persist()/flush().
 * Motivo: o passo de reserva da WagerTransaction precisa tentar um INSERT que
 * pode falhar por violacao de UNIQUE dentro de um SAVEPOINT — se isso fosse
 * uma entidade gerenciada pelo MikroORM, ela ficaria "presa" no Unit of Work
 * esperando outro flush depois do rollback do savepoint. Fazendo tudo via SQL
 * explicito, nao ha Unit of Work para poluir: cada instrucao e independente.
 *
 * `em.getConnection()` sozinho NAO amarra as queries a transacao aberta por
 * em.transactional() — e preciso passar o contexto de transacao
 * (em.getTransactionContext()) explicitamente em toda chamada, senao o
 * Postgres roda cada instrucao em autocommit, fora da transacao esperada.
 */

function execute<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T> {
  return em.getConnection().execute(sql, params, 'all', em.getTransactionContext()) as Promise<T>;
}

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance_amount: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface WagerTransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  created_at: Date;
  processed_at: Date | null;
  result_balance_amount: string | null;
  result_balance_currency: string | null;
  attempts: number;
  next_attempt_at: Date | null;
}

/** Linha PENDING_REFERENCE devida agora, com o veredito de TTL calculado pelo proprio Postgres. */
export interface DuePendingReferenceRow extends WagerTransactionRow {
  ttl_expired: boolean;
}

export function walletRowToDomain(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: row.balance_amount, currency: row.currency }),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function wagerTransactionRowToDomain(row: WagerTransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: row.created_at,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code as FailureCode | null) ?? undefined,
    processedAt: row.processed_at ?? undefined,
  });
}

export async function selectWagerTransactionByIdempotencyKey(
  em: EntityManager,
  idempotencyKey: string,
): Promise<WagerTransactionRow | undefined> {
  const rows = await execute<WagerTransactionRow[]>(
    em,
    'SELECT * FROM wager_transactions WHERE idempotency_key = ?',
    [idempotencyKey],
  );
  return rows[0];
}

export async function selectWalletForUpdate(em: EntityManager, walletId: string): Promise<WalletRow | undefined> {
  const rows = await execute<WalletRow[]>(em, 'SELECT * FROM wallets WHERE id = ? FOR UPDATE', [walletId]);
  return rows[0];
}

/** Resolve uma referencia (REFUND/ROLLBACK/WIN opcional) por provider + externalTransactionId. */
export async function selectWagerTransactionByProviderAndExternalId(
  em: EntityManager,
  providerId: string,
  externalTransactionId: string,
): Promise<WagerTransactionRow | undefined> {
  const rows = await execute<WagerTransactionRow[]>(
    em,
    'SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
    [providerId, externalTransactionId],
  );
  return rows[0];
}

/**
 * Existe algum REFUND/ROLLBACK ja apontando para essa referencia? Chamado
 * DEPOIS de travar a wallet (a mesma wallet que a referencia pertence) — o
 * lock serializa duas reversoes concorrentes da mesma referencia, entao esta
 * consulta ja e garantia real aqui, nao so otimizacao (a constraint UNIQUE do
 * banco continua existindo como ultima defesa, mas nao deveria ser atingida
 * na pratica com essa ordem).
 */
export async function selectExistingReversal(
  em: EntityManager,
  referenceTransactionId: string,
  kind: WagerTransactionKind,
): Promise<boolean> {
  const rows = await execute<{ found: boolean }[]>(
    em,
    'SELECT EXISTS(SELECT 1 FROM wager_transactions WHERE reference_transaction_id = ? AND kind = ?) AS found',
    [referenceTransactionId, kind],
  );
  return rows[0].found;
}

export async function createSavepoint(em: EntityManager, name: string): Promise<void> {
  await execute(em, `SAVEPOINT ${name}`);
}

export async function rollbackToSavepoint(em: EntityManager, name: string): Promise<void> {
  await execute(em, `ROLLBACK TO SAVEPOINT ${name}`);
}

export async function insertPendingWagerTransaction(em: EntityManager, tx: WagerTransaction): Promise<void> {
  await execute(
    em,
    `INSERT INTO wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.id,
      tx.providerId,
      tx.externalTransactionId,
      tx.idempotencyKey,
      tx.payloadHash,
      tx.walletId,
      tx.playerId,
      tx.roundId,
      tx.gameId,
      tx.kind,
      tx.money.toJSON().amount,
      tx.money.currency,
      tx.referenceExternalTransactionId ?? null,
      tx.status,
      tx.createdAt,
    ],
  );
}

export async function updateWalletBalance(em: EntityManager, wallet: Wallet): Promise<void> {
  await execute(em, 'UPDATE wallets SET balance_amount = ?, version = ?, updated_at = ? WHERE id = ?', [
    wallet.balance.toJSON().amount,
    wallet.version,
    wallet.updatedAt,
    wallet.id,
  ]);
}

export async function insertLedgerEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
  await execute(
    em,
    `INSERT INTO wallet_ledger_entries (
       id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.walletId,
      entry.transactionId,
      entry.direction,
      entry.money.toJSON().amount,
      entry.money.currency,
      entry.balanceBefore.toJSON().amount,
      entry.balanceAfter.toJSON().amount,
      entry.createdAt,
    ],
  );
}

/**
 * Primeira vez que a transacao vira PENDING_REFERENCE (fluxo HTTP sincrono).
 * attempts comeca em 0 (o worker ainda nao tentou nada) e a proxima tentativa
 * fica devida imediatamente — o worker pega no proximo tick. Nao mexe em
 * processed_at/failure_code/result_balance, que ficam NULL.
 */
export async function updateWagerTransactionPending(em: EntityManager, tx: WagerTransaction): Promise<void> {
  await execute(em, 'UPDATE wager_transactions SET status = ?, attempts = 0, next_attempt_at = now() WHERE id = ?', [
    tx.status,
    tx.id,
  ]);
}

/**
 * A referencia ainda nao foi resolvida (nao encontrada, ou encontrada mas
 * ainda ela mesma PENDING_REFERENCE) — continua PENDING_REFERENCE, so
 * incrementa attempts e reagenda a proxima tentativa. `delaySeconds` vem do
 * backoff calculado em JS, mas o instante em si (`now()`) e sempre o do
 * Postgres, nunca o relogio da aplicacao — evita divergencia de relogio
 * entre instancias/maquinas diferentes.
 */
export async function updateWagerTransactionRetry(
  em: EntityManager,
  transactionId: string,
  delaySeconds: number,
): Promise<void> {
  await execute(
    em,
    `UPDATE wager_transactions
     SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => ?)
     WHERE id = ?`,
    [delaySeconds, transactionId],
  );
}

/**
 * Reivindica, com FOR UPDATE SKIP LOCKED, uma linha PENDING_REFERENCE devida
 * agora. Se outra instancia/worker ja estiver com essa linha travada, o
 * Postgres simplesmente a pula em vez de esperar — por isso duas instancias
 * rodando a mesma consulta ao mesmo tempo nunca pegam a mesma linha.
 * `ttl_expired` e calculado pelo proprio Postgres (now() - created_at), nunca
 * comparado contra o relogio da aplicacao.
 */
export async function selectDuePendingReferenceForUpdate(
  em: EntityManager,
  ttlMinutes: number,
): Promise<DuePendingReferenceRow | undefined> {
  const rows = await execute<DuePendingReferenceRow[]>(
    em,
    `SELECT *, (now() - created_at) > make_interval(mins => ?) AS ttl_expired
     FROM wager_transactions
     WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
     ORDER BY next_attempt_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
    [ttlMinutes],
  );
  return rows[0];
}

/**
 * Grava um desfecho terminal (PROCESSED ou REJECTED). Sempre zera
 * next_attempt_at — uma transacao terminal nunca mais e devida pelo worker,
 * a constraint wager_transactions_next_attempt_consistency exige isso.
 * attempts fica como estava (contagem historica de quantas vezes o worker
 * tentou antes de chegar aqui).
 */
export async function updateWagerTransactionOutcome(
  em: EntityManager,
  tx: WagerTransaction,
  resultBalance: Money,
): Promise<void> {
  await execute(
    em,
    `UPDATE wager_transactions
     SET status = ?, processed_at = ?, failure_code = ?, reference_transaction_id = ?,
         result_balance_amount = ?, result_balance_currency = ?, next_attempt_at = NULL
     WHERE id = ?`,
    [
      tx.status,
      tx.processedAt ?? null,
      tx.failureCode ?? null,
      tx.referenceTransactionId ?? null,
      resultBalance.toJSON().amount,
      resultBalance.currency,
      tx.id,
    ],
  );
}
