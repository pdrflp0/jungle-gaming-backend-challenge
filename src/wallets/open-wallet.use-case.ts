import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../domain/money/money';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { OpenWalletDto } from './dto/open-wallet.dto';
import { toLedgerEntryEntity, toWagerTransactionEntity, toWalletEntity } from './persistence.mapper';

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

/** Le a propriedade "constraint" de um erro so se ela realmente existir e for string. */
function getConstraintName(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'constraint' in error) {
    const value = (error as { constraint: unknown }).constraint;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(dto: OpenWalletDto): Promise<OpenWalletResult> {
    const id = randomUUID();
    const now = new Date();
    const initialBalance = Money.from(dto.initialBalance);

    // id/horario da abertura sao gerados aqui, na aplicacao — nunca dentro do dominio.
    const opening = initialBalance.isPositive()
      ? { transactionId: randomUUID(), entryId: randomUUID() }
      : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id,
      playerId: dto.playerId,
      initialBalance,
      now,
      opening,
    });

    const openingTransaction = opening
      ? WagerTransaction.createOpening({
          id: opening.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `opening:${wallet.id}`,
          payloadHash: 'internal-opening',
          money: initialBalance,
          createdAt: now,
        })
      : undefined;

    try {
      await this.em.transactional(async (em) => {
        // flush em estagios, na ordem das foreign keys: as entidades usam colunas
        // simples (nao relacoes @ManyToOne), entao o MikroORM nao sabe que o ledger
        // depende da transacao, que depende da wallet — sem isso, ele pode mandar os
        // INSERTs fora de ordem e o Postgres rejeita a FK na hora (nao no fim da
        // transacao). Tudo continua dentro da mesma transacao SQL.
        em.persist(toWalletEntity(wallet));
        await em.flush();

        if (openingTransaction && openingEntry) {
          em.persist(toWagerTransactionEntity(openingTransaction));
          await em.flush();

          em.persist(toLedgerEntryEntity(openingEntry));
          await em.flush();
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && getConstraintName(error) === 'wallets_player_currency_unique') {
        throw new ConflictException('A wallet already exists for this player and currency');
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
