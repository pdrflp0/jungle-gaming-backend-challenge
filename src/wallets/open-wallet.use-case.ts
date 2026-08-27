import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  InvalidMoneyAmountError,
  InvalidMoneyCurrencyError,
  Money,
  MoneyAmountOverflowError,
} from '../domain/money/money';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/messaging/wagering-events';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { insertOutboxMessage } from '../messaging/outbox.sql';
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

  async execute(dto: OpenWalletDto, correlationId: string): Promise<OpenWalletResult> {
    const id = randomUUID();
    const now = new Date();

    let initialBalance: Money;
    try {
      initialBalance = Money.from(dto.initialBalance);
    } catch (error) {
      if (
        error instanceof InvalidMoneyAmountError ||
        error instanceof InvalidMoneyCurrencyError ||
        error instanceof MoneyAmountOverflowError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

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
          const openingEntity = toWagerTransactionEntity(openingTransaction);
          openingEntity.correlationId = correlationId;
          em.persist(openingEntity);
          await em.flush();

          em.persist(toLedgerEntryEntity(openingEntry));
          await em.flush();

          const processedEvent = WagerTransactionProcessed.create({
            eventId: randomUUID(),
            aggregateId: openingTransaction.id,
            correlationId,
            occurredAt: now,
            data: {
              transactionId: openingTransaction.id,
              walletId: wallet.id,
              playerId: wallet.playerId,
              providerId: openingTransaction.providerId,
              kind: openingTransaction.kind,
              money: initialBalance.toJSON(),
              balance: wallet.balance.toJSON(),
              processedAt: now.toISOString(),
            },
          });
          await insertOutboxMessage(em, OutboxMessage.enqueue(processedEvent));

          const balanceChangedEvent = WalletBalanceChanged.create({
            eventId: randomUUID(),
            aggregateId: wallet.id,
            correlationId,
            occurredAt: now,
            data: {
              walletId: wallet.id,
              transactionId: openingTransaction.id,
              direction: openingEntry.direction,
              money: openingEntry.money.toJSON(),
              balanceBefore: openingEntry.balanceBefore.toJSON(),
              balanceAfter: openingEntry.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
          });
          await insertOutboxMessage(em, OutboxMessage.enqueue(balanceChangedEvent));
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
