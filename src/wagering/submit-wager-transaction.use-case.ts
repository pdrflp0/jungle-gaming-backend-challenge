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
import { LedgerDirection } from '../domain/wallet/wallet-ledger-entry';
import {
  FailureCode,
  InvalidReferenceError,
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
  selectExistingReversal,
  selectWagerTransactionByIdempotencyKey,
  selectWagerTransactionByProviderAndExternalId,
  selectWalletForUpdate,
  updateWagerTransactionOutcome,
  updateWagerTransactionPending,
  updateWalletBalance,
  wagerTransactionRowToDomain,
  walletRowToDomain,
  WagerTransactionRow,
} from './wager-transaction.sql';

/** WIN/REFUND/ROLLBACK podem envolver referencia; BET e LOSS nunca olham para ela. */
const REFERENCE_AWARE_KINDS = [WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

export interface SubmitWagerTransactionResponse {
  httpStatus: 200 | 201 | 202;
  body: {
    transactionId: string;
    status: string;
    idempotentReplay: boolean;
    balance?: { amount: string; currency: string };
    failureCode?: string;
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
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
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
        kind: dto.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
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
    let outcome: { status: WagerTransactionStatus; balance?: Money } | undefined;

    await this.em.transactional(async (em) => {
      // 1. trava a wallet primeiro — e o que serializa duas reversoes
      // concorrentes da mesma referencia (ambas disputam a MESMA wallet).
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

      if (walletRow.player_id !== dto.playerId) {
        // wallet existe, mas pertence a outro jogador — nao toca saldo nem ledger.
        transaction.reject(FailureCode.PlayerMismatch);
        await updateWagerTransactionOutcome(em, transaction, wallet.balance);
        outcome = { status: transaction.status, balance: wallet.balance };
        return;
      }

      if (transaction.kind === WagerTransactionKind.Loss) {
        transaction.markProcessed(undefined, now);
        await updateWagerTransactionOutcome(em, transaction, wallet.balance);
        outcome = { status: transaction.status, balance: wallet.balance };
        return;
      }

      // 2. resolve a referencia (se essa kind olha para referencia e uma foi
      // fornecida). BET nunca entra aqui, mesmo que receba o campo por engano.
      const shouldResolveReference = REFERENCE_AWARE_KINDS.includes(transaction.kind) && transaction.hasReference();
      const referenceRow = shouldResolveReference
        ? await selectWagerTransactionByProviderAndExternalId(
            em,
            dto.providerId,
            transaction.referenceExternalTransactionId as string,
          )
        : undefined;

      if (shouldResolveReference && !referenceRow) {
        transaction.markPendingReference();
        await updateWagerTransactionPending(em, transaction);
        outcome = { status: transaction.status };
        return;
      }

      const referenceDomain = referenceRow ? wagerTransactionRowToDomain(referenceRow) : undefined;

      try {
        const direction = transaction.ledgerDirectionFor(referenceDomain);

        // 3. verifica reversao anterior — so se aplica a REFUND/ROLLBACK, que
        // sao os unicos kinds com a constraint UNIQUE(reference_transaction_id, kind).
        let alreadyReversed = false;
        if (
          referenceDomain &&
          (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback)
        ) {
          alreadyReversed = await selectExistingReversal(em, referenceDomain.id, transaction.kind);
        }

        // 4. aplica ou rejeita.
        if (alreadyReversed) {
          transaction.reject(FailureCode.ReferenceAlreadyReversed);
        } else {
          const ledgerEntry =
            direction === LedgerDirection.Credit
              ? wallet.credit({ money: transaction.money, transactionId: transaction.id, entryId: randomUUID(), now })
              : wallet.debit({ money: transaction.money, transactionId: transaction.id, entryId: randomUUID(), now });
          transaction.markProcessed(referenceDomain?.id, now);
          await updateWalletBalance(em, wallet);
          await insertLedgerEntry(em, ledgerEntry);
        }
      } catch (error) {
        if (error instanceof InvalidReferenceError) {
          transaction.reject(FailureCode.InvalidReference);
        } else if (error instanceof InsufficientFundsError) {
          transaction.reject(
            transaction.kind === WagerTransactionKind.Rollback
              ? FailureCode.ReversalWouldMakeBalanceNegative
              : FailureCode.InsufficientFunds,
          );
        } else if (error instanceof WalletCurrencyMismatchError) {
          transaction.reject(FailureCode.CurrencyMismatch);
        } else if (error instanceof MoneyAmountOverflowError) {
          transaction.reject(FailureCode.BalanceLimitExceeded);
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

    if (outcome.status === WagerTransactionStatus.PendingReference) {
      return {
        httpStatus: 202,
        body: { transactionId: transaction.id, status: outcome.status, idempotentReplay: false },
      };
    }

    const body = {
      transactionId: transaction.id,
      status: outcome.status,
      balance: outcome.balance?.toJSON(),
      idempotentReplay: false,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
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

    // PENDING_REFERENCE ainda nao tem resultado financeiro nenhum — nada de
    // balance/failureCode aqui. No Bloco 7b, depois que o worker resolver a
    // referencia (PROCESSED ou REJECTED), um novo replay ja vai cair no ramo
    // abaixo e devolver o saldo historico normalmente.
    if (row.status === WagerTransactionStatus.PendingReference) {
      return {
        httpStatus: 202,
        body: { transactionId: row.id, status: row.status, idempotentReplay: true },
      };
    }

    // Uma BET/WIN/REFUND/ROLLBACK terminal (PROCESSED ou REJECTED) sempre
    // grava seu saldo observado (ver updateWagerTransactionOutcome). Se
    // estiver faltando, e inconsistencia interna real — falha com erro
    // claro, nunca inventa um resultado financeiro (nada de "?? 0.00" aqui).
    if (row.result_balance_amount === null || row.result_balance_currency === null) {
      throw new Error(
        `Wager transaction ${row.id} is terminal (status=${row.status}) but has no recorded result balance`,
      );
    }

    const body = {
      transactionId: row.id,
      status: row.status,
      balance: { amount: row.result_balance_amount, currency: row.result_balance_currency },
      idempotentReplay: true,
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    };

    if (row.status === WagerTransactionStatus.Processed) {
      return { httpStatus: 200, body };
    }

    throw new UnprocessableEntityException(body);
  }
}
