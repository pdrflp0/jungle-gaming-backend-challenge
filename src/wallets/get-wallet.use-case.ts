import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { selectWalletById } from './wallet.sql';

export interface GetWalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

@Injectable()
export class GetWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string): Promise<GetWalletResponse> {
    const row = await selectWalletById(this.em, walletId);
    if (!row) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    return {
      id: row.id,
      playerId: row.player_id,
      balance: { amount: row.balance_amount, currency: row.currency },
      version: row.version,
    };
  }
}
