import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Consultas puras de leitura para os endpoints GET (Bloco 8a). Diferente do
 * SQL cru do fluxo de escrita (src/wagering/wager-transaction.sql.ts), aqui
 * nao existe `em.transactional()` nem `em.getTransactionContext()`: cada
 * funcao roda uma unica SELECT, sem lock, fora de qualquer transacao aberta
 * — nao ha nada para amarrar, e nada para fazer atomico.
 */

function execute<T>(em: EntityManager, sql: string, params: unknown[] = []): Promise<T> {
  return em.getConnection().execute(sql, params) as Promise<T>;
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

export interface LedgerEntryRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

export async function selectWalletById(em: EntityManager, walletId: string): Promise<WalletRow | undefined> {
  const rows = await execute<WalletRow[]>(em, 'SELECT * FROM wallets WHERE id = ?', [walletId]);
  return rows[0];
}

/**
 * Pagina o ledger em ordem crescente por (created_at, id) — o mesmo par
 * coberto pelo indice `wallet_ledger_entries_wallet_created_idx`, criado no
 * Bloco 4. `id` desempata quando duas entradas caem no mesmo instante, o que
 * evita pular ou repetir linhas entre paginas. `after`, quando presente,
 * usa a comparacao de tupla do Postgres `(created_at, id) > (?, ?)` — uma
 * unica condicao que já implementa paginacao por keyset corretamente.
 */
export async function selectWalletLedgerPage(
  em: EntityManager,
  walletId: string,
  after: { createdAt: Date; id: string } | undefined,
  limit: number,
): Promise<LedgerEntryRow[]> {
  if (after) {
    return execute<LedgerEntryRow[]>(
      em,
      `SELECT * FROM wallet_ledger_entries
       WHERE wallet_id = ? AND (created_at, id) > (?, ?)
       ORDER BY created_at, id
       LIMIT ?`,
      [walletId, after.createdAt, after.id, limit],
    );
  }

  return execute<LedgerEntryRow[]>(
    em,
    'SELECT * FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at, id LIMIT ?',
    [walletId, limit],
  );
}
