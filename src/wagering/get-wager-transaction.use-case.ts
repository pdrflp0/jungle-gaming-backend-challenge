import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  selectWagerTransactionById,
  selectWagerTransactionByProviderAndExternalId,
  WagerTransactionRow,
} from './wager-transaction.sql';

/**
 * Nunca expoe `payloadHash` nem `idempotencyKey` — sao detalhes internos do
 * mecanismo de idempotencia, nao do estado de negocio da transacao.
 * `balance`/`failureCode`/`referenceExternalTransactionId`/`referenceTransactionId`/
 * `processedAt` so aparecem quando existem de verdade (ver toResponse) —
 * nunca inventados para preencher o formato.
 */
export interface WagerTransactionQueryResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: string;
  failureCode?: string;
  createdAt: string;
  processedAt?: string;
  balance?: { amount: string; currency: string };
}

function toResponse(row: WagerTransactionRow): WagerTransactionQueryResponse {
  return {
    transactionId: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: { amount: row.amount, currency: row.currency },
    ...(row.reference_external_transaction_id
      ? { referenceExternalTransactionId: row.reference_external_transaction_id }
      : {}),
    ...(row.reference_transaction_id ? { referenceTransactionId: row.reference_transaction_id } : {}),
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    // consultas cruas podem devolver timestamptz como string, nao Date —
    // normaliza antes de formatar (visto no Bloco 7b).
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.processed_at ? { processedAt: new Date(row.processed_at).toISOString() } : {}),
    ...(row.result_balance_amount !== null && row.result_balance_currency !== null
      ? { balance: { amount: row.result_balance_amount, currency: row.result_balance_currency } }
      : {}),
  };
}

/**
 * Consultas de leitura por dois identificadores diferentes do MESMO recurso
 * (GET /wagering/transactions/:id e GET /providers/:providerId/wagering/transactions/:externalId,
 * CHALLENGE.md secao 9). Retorna sempre HTTP 200 quando encontra a linha,
 * seja qual for o status de negocio — o estado (PROCESSED/REJECTED/FAILED/
 * PENDING_REFERENCE) vai no corpo, nunca no status HTTP. Isso e diferente do
 * POST /wagering/transactions, que usa o status HTTP para sinalizar o
 * resultado do processamento; aqui so estamos relatando o que ja existe.
 */
@Injectable()
export class GetWagerTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async byId(transactionId: string): Promise<WagerTransactionQueryResponse> {
    const row = await selectWagerTransactionById(this.em, transactionId);
    if (!row) {
      throw new NotFoundException(`Wager transaction ${transactionId} not found`);
    }
    return toResponse(row);
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionQueryResponse> {
    const row = await selectWagerTransactionByProviderAndExternalId(this.em, providerId, externalTransactionId);
    if (!row) {
      throw new NotFoundException(`Transaction ${externalTransactionId} from provider ${providerId} not found`);
    }
    return toResponse(row);
  }
}
