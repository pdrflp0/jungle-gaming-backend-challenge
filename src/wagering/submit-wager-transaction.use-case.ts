import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DeadlockException, LockWaitTimeoutException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  InvalidMoneyAmountError,
  InvalidMoneyCurrencyError,
  Money,
  MoneyAmountOverflowError,
} from '../domain/money/money';
import { InsufficientFundsError, WalletCurrencyMismatchError } from '../domain/wallet/wallet';
import {
  FailureCode,
  InvalidWagerAmountError,
  MissingReferenceError,
  OpeningIsInternalError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction';
import { SubmitWagerTransactionDto } from './dto/submit-wager-transaction.dto';
import { computePayloadHash } from './payload-hash';
import {
  createSavepoint,
  insertLedgerEntry,
  insertPendingWagerTransaction,
  rollbackToSavepoint,
  selectWagerTransactionByIdempotencyKey,
  selectWalletForUpdate,
  updateWagerTransactionOutcome,
  updateWalletBalance,
  walletRowToDomain,
  WagerTransactionRow,
} from './wager-transaction.sql';

export interface SubmitWagerTransactionResponse {
  httpStatus: 200 | 201;
  body: {
    transactionId: string;
    status: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
  };
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
export class SubmitWagerTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(idempotencyKey: string, dto: SubmitWagerTransactionDto): Promise<SubmitWagerTransactionResponse> {
    try {
      return await this.run(idempotencyKey, dto);
    } catch (error) {
      if (error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
        throw new ServiceUnavailableException('Temporary database contention, please retry');
      }
      throw error;
    }
  }

  private async run(idempotencyKey: string, dto: SubmitWagerTransactionDto): Promise<SubmitWagerTransactionResponse> {
    const payloadHash = computePayloadHash({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
    });

    // Passo opcional/otimizacao: se a key ja existe, resolve sem abrir transacao
    // nem travar a wallet. A garantia de verdade contra corrida esta no INSERT
    // dentro do SAVEPOINT mais abaixo, nunca nesta leitura isolada.
    const preCheck = await selectWagerTransactionByIdempotencyKey(this.em, idempotencyKey);
    if (preCheck) {
      return this.resolveExisting(preCheck, payloadHash);
    }

    let money: Money;
    try {
      money = Money.from(dto.money);
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

    const now = new Date();
    let transaction: WagerTransaction;
    try {
      transaction = WagerTransaction.create({
        id: randomUUID(),
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: dto.walletId,
        playerId: dto.playerId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: WagerTransactionKind.Bet,
        money,
        createdAt: now,
      });
    } catch (error) {
      if (
        error instanceof OpeningIsInternalError ||
        error instanceof InvalidWagerAmountError ||
        error instanceof MissingReferenceError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    let walletNotFound = false;
    let existingAfterConflict: WagerTransactionRow | undefined;
    let providerExternalConflict = false;
    let outcome: { status: WagerTransactionStatus; balance: Money } | undefined;

    await this.em.transactional(async (em) => {
      const walletRow = await selectWalletForUpdate(em, dto.walletId);
      if (!walletRow) {
        walletNotFound = true;
        return;
      }

      await createSavepoint(em, 'reserve_wager_transaction');
      try {
        await insertPendingWagerTransaction(em, transaction);
      } catch (error) {
        if (!(error instanceof UniqueConstraintViolationException)) {
          throw error;
        }

        await rollbackToSavepoint(em, 'reserve_wager_transaction');
        const constraintName = getConstraintName(error);

        if (constraintName === 'wager_transactions_idempotency_key_unique') {
          const winner = await selectWagerTransactionByIdempotencyKey(em, idempotencyKey);
          if (!winner) {
            // a constraint so estoura se a linha existir e ja estiver commitada — nao deveria acontecer.
            throw error;
          }
          existingAfterConflict = winner;
          return;
        }

        if (constraintName === 'wager_transactions_provider_external_unique') {
          providerExternalConflict = true;
          return;
        }

        throw error;
      }

      const wallet = walletRowToDomain(walletRow);

      try {
        const ledgerEntry = wallet.debit({
          money: transaction.money,
          transactionId: transaction.id,
          entryId: randomUUID(),
          now,
        });
        transaction.markProcessed(undefined, now);
        await updateWalletBalance(em, wallet);
        await insertLedgerEntry(em, ledgerEntry);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          transaction.reject(FailureCode.InsufficientFunds);
        } else if (error instanceof WalletCurrencyMismatchError) {
          transaction.reject(FailureCode.CurrencyMismatch);
        } else {
          throw error;
        }
      }

      await updateWagerTransactionOutcome(em, transaction, wallet.balance);
      outcome = { status: transaction.status, balance: wallet.balance };
    });

    if (walletNotFound) {
      throw new NotFoundException(`Wallet ${dto.walletId} not found`);
    }

    if (providerExternalConflict) {
      throw new ConflictException({
        message: 'This providerId + externalTransactionId was already submitted with a different Idempotency-Key',
        code: 'EXTERNAL_TRANSACTION_ALREADY_SUBMITTED',
      });
    }

    if (existingAfterConflict) {
      return this.resolveExisting(existingAfterConflict, payloadHash);
    }

    if (!outcome) {
      throw new Error('Unexpected: wager transaction processing produced no outcome');
    }

    const body = {
      transactionId: transaction.id,
      status: outcome.status,
      balance: outcome.balance.toJSON(),
      idempotentReplay: false,
    };

    if (outcome.status === WagerTransactionStatus.Processed) {
      return { httpStatus: 201, body };
    }

    throw new UnprocessableEntityException(body);
  }

  private resolveExisting(row: WagerTransactionRow, payloadHash: string): SubmitWagerTransactionResponse {
    if (row.payload_hash !== payloadHash) {
      throw new ConflictException({
        message: 'Idempotency-Key already used with a different payload',
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      });
    }

    const body = {
      transactionId: row.id,
      status: row.status,
      balance: {
        amount: row.result_balance_amount ?? '0.00',
        currency: row.result_balance_currency ?? 'BRL',
      },
      idempotentReplay: true,
    };

    if (row.status === WagerTransactionStatus.Processed) {
      return { httpStatus: 200, body };
    }

    throw new UnprocessableEntityException(body);
  }
}
