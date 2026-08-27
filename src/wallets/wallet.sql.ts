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

export interface ReconciliationRow {
  stored_balance: string;
  currency: string;
  calculated_balance: string;
  difference: string;
  consistent: boolean;
  checked_entries: number;
}

/**
 * Uma unica consulta com LEFT JOIN + GROUP BY: le a wallet e agrega o ledger
 * inteiro na mesma foto MVCC do Postgres — nao ha "duas leituras" entre as
 * quais uma transacao concorrente possa confirmar e criar uma divergencia
 * falsa. LEFT JOIN (nao INNER) e o que faz uma wallet sem nenhum lancamento
 * ainda aparecer no resultado, com checked_entries=0.
 *
 * Todo `::numeric(19,2)` explicito existe para garantir sempre exatamente 2
 * casas decimais na saida — sem o cast, `COALESCE(SUM(...), 0)` quando nao
 * ha nenhuma linha agregada vira o literal `0` (sem escala), nao "0.00".
 * `difference` pode ser negativo (saldo reconstruido maior que o
 * armazenado) — por isso nao passa pelo Money do dominio, que proibe
 * negativo por contrato; aqui e so uma string decimal com sinal, para
 * diagnostico.
 */
export async function selectWalletReconciliation(
  em: EntityManager,
  walletId: string,
): Promise<ReconciliationRow | undefined> {
  const rows = await execute<ReconciliationRow[]>(
    em,
    `SELECT
       w.balance_amount::numeric(19,2) AS stored_balance,
       w.currency AS currency,
       COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END), 0)::numeric(19,2)
         AS calculated_balance,
       (w.balance_amount - COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END), 0))::numeric(19,2)
         AS difference,
       (w.balance_amount = COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END), 0))
         AS consistent,
       COUNT(le.id)::int AS checked_entries
     FROM wallets w
     LEFT JOIN wallet_ledger_entries le ON le.wallet_id = w.id
     WHERE w.id = ?
     GROUP BY w.id, w.balance_amount, w.currency`,
    [walletId],
  );
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
