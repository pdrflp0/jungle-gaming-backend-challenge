import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { WagerTransactionRejected } from '../domain/messaging/wagering-events';
import { FailureCode, WagerTransactionStatus } from '../domain/wagering/wager-transaction';
import { insertOutboxMessage } from '../messaging/outbox.sql';
import { pendingReferenceRetriesTotal } from '../observability/metrics';
import { applyReferenceAwareOutcome } from './resolve-wager-reference';
import {
  computeNextAttemptDelaySeconds,
  PENDING_REFERENCE_TTL_MINUTES,
  PENDING_REFERENCE_WORKER_MAX_BATCH_SIZE,
  PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS,
} from './retry-worker.config';
import {
  selectDuePendingReferenceForUpdate,
  selectWagerTransactionByProviderAndExternalId,
  selectWalletForUpdate,
  updateWagerTransactionOutcome,
  updateWagerTransactionRetry,
  wagerTransactionRowToDomain,
  walletRowToDomain,
} from './wager-transaction.sql';

/**
 * Desligado por padrao. `src/main.ts` liga explicitamente para a aplicacao
 * real (`bun run start`). Os testes nunca setam essa variavel, entao o tick
 * automatico roda mas sempre retorna sem fazer nada — os testes chamam
 * `processDueOnce`/`processDueBatch` diretamente, sem depender do timer nem
 * correr risco de o timer interferir no meio de uma asserção.
 */
function isWorkerPollingEnabled(): boolean {
  return process.env.PENDING_REFERENCE_WORKER_ENABLED === 'true';
}

/**
 * Reprocessa transacoes PENDING_REFERENCE (Bloco 7b — CHALLENGE.md secao
 * 7.1). So WIN (referencia opcional), REFUND e ROLLBACK chegam aqui — sao os
 * unicos kinds que a WagerTransaction permite ficar PENDING_REFERENCE.
 */
@Injectable()
export class RetryPendingReferenceWorker {
  constructor(private readonly em: EntityManager) {}

  @Interval(PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS)
  async tick(): Promise<void> {
    if (!isWorkerPollingEnabled()) {
      return;
    }
    await this.processDueBatch();
  }

  /**
   * Processa ate `maxBatchSize` linhas devidas agora, uma transacao curta
   * por linha (nunca uma transacao so para o lote inteiro — mantem no maximo
   * um lock de wallet por vez). Retorna quantas linhas processou. Chamavel
   * diretamente pelos testes, sem depender do @Interval.
   */
  async processDueBatch(maxBatchSize: number = PENDING_REFERENCE_WORKER_MAX_BATCH_SIZE): Promise<number> {
    let processed = 0;
    while (processed < maxBatchSize) {
      const didProcess = await this.processDueOnce();
      if (!didProcess) {
        break;
      }
      processed += 1;
    }
    return processed;
  }

  /**
   * Processa exatamente uma linha PENDING_REFERENCE devida, numa transacao
   * propria. Retorna `false` se nao havia nenhuma linha devida agora — seja
   * porque nao existe nenhuma, seja porque outro worker (outra instancia, ou
   * outra chamada concorrente a este mesmo metodo) ja a travou primeiro via
   * FOR UPDATE SKIP LOCKED. Retorna `true` se processou (resolveu, continuou
   * pendente, ou rejeitou por TTL).
   */
  async processDueOnce(): Promise<boolean> {
    let claimed = false;

    await this.em.transactional(async (em) => {
      const dueRow = await selectDuePendingReferenceForUpdate(em, PENDING_REFERENCE_TTL_MINUTES);
      if (!dueRow) {
        return;
      }
      claimed = true;

      // Mesma ordem do fluxo HTTP: trava a wallet antes de decidir qualquer coisa.
      const walletRow = await selectWalletForUpdate(em, dueRow.wallet_id);
      if (!walletRow) {
        throw new Error(`Wager transaction ${dueRow.id} references missing wallet ${dueRow.wallet_id}`);
      }
      const wallet = walletRowToDomain(walletRow);
      const transaction = wagerTransactionRowToDomain(dueRow);
      const now = new Date();

      // Preservados desde quando a transacao entrou em PENDING_REFERENCE
      // (submit-wager-transaction.use-case.ts) — o worker nunca inventa
      // nenhum dos dois. causationId fica undefined so para linhas legadas
      // que nunca passaram por ali (pending_reference_event_id NULL).
      const correlationId = dueRow.correlation_id;
      const causationId = dueRow.pending_reference_event_id ?? undefined;

      if (dueRow.ttl_expired) {
        transaction.reject(FailureCode.ReferenceNotFound);
        await updateWagerTransactionOutcome(em, transaction, wallet.balance);
        await insertOutboxMessage(
          em,
          OutboxMessage.enqueue(
            WagerTransactionRejected.create({
              eventId: randomUUID(),
              aggregateId: transaction.id,
              correlationId,
              causationId,
              occurredAt: now,
              data: {
                transactionId: transaction.id,
                walletId: transaction.walletId,
                playerId: transaction.playerId,
                providerId: transaction.providerId,
                kind: transaction.kind,
                money: transaction.money.toJSON(),
                balance: wallet.balance.toJSON(),
                failureCode: transaction.failureCode as FailureCode,
              },
            }),
          ),
        );
        return;
      }

      const referenceRow = await selectWagerTransactionByProviderAndExternalId(
        em,
        dueRow.provider_id,
        dueRow.reference_external_transaction_id as string,
      );

      const stillUnresolved = !referenceRow || referenceRow.status === WagerTransactionStatus.PendingReference;

      if (stillUnresolved) {
        const attemptNumber = dueRow.attempts + 1;
        await updateWagerTransactionRetry(em, transaction.id, computeNextAttemptDelaySeconds(attemptNumber));
        pendingReferenceRetriesTotal.inc({ kind: transaction.kind });
        return;
      }

      await applyReferenceAwareOutcome(em, transaction, wallet, referenceRow, now, correlationId, causationId);
    });

    return claimed;
  }
}
