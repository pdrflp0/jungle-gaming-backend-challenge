import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { decodeLedgerCursor, encodeLedgerCursor, InvalidLedgerCursorError } from './ledger-cursor';
import { LedgerEntryRow, selectWalletById, selectWalletLedgerPage } from './wallet.sql';

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt: string;
}

export interface GetWalletLedgerResponse {
  walletId: string;
  entries: LedgerEntryResponse[];
  nextCursor: string | null;
}

function toLedgerEntryResponse(row: LedgerEntryRow): LedgerEntryResponse {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    direction: row.direction,
    money: { amount: row.amount, currency: row.currency },
    balanceBefore: { amount: row.balance_before, currency: row.currency },
    balanceAfter: { amount: row.balance_after, currency: row.currency },
    // consultas cruas podem devolver timestamptz como string, nao Date —
    // normaliza antes de formatar (visto no Bloco 7b).
    createdAt: new Date(row.created_at).toISOString(),
  };
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string, cursor: string | undefined, limit: number): Promise<GetWalletLedgerResponse> {
    const wallet = await selectWalletById(this.em, walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    let after: { createdAt: Date; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        after = decodeLedgerCursor(cursor);
      } catch (error) {
        if (error instanceof InvalidLedgerCursorError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    }

    // busca uma linha a mais do que o limite pedido: se ela vier, sabemos
    // que existe proxima pagina sem precisar de uma segunda consulta (tipo
    // COUNT). A linha extra e sempre descartada da resposta.
    const rows = await selectWalletLedgerPage(this.em, walletId, after, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      walletId,
      entries: page.map(toLedgerEntryResponse),
      nextCursor: hasMore && last ? encodeLedgerCursor(new Date(last.created_at), last.id) : null,
    };
  }
}
