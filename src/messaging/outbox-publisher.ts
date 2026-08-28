import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { computeOutboxNextAttemptDelaySeconds } from '../domain/messaging/outbox-retry-backoff';
import { outboxPublishRetriesTotal } from '../observability/metrics';
import { logStructuredWarning } from '../observability/structured-logger';
import {
  markOutboxMessagePublished,
  scheduleOutboxMessageRetry,
  selectDueOutboxMessageForUpdate,
} from './outbox.sql';

/**
 * Fila de SAIDA do publisher (Bloco 9c). O CHALLENGE.md so nomeia a fila de
 * ENTRADA (secao 10); este nome e uma decisao deste projeto, aprovada em
 * bloco, e precisa bater exatamente com `EVENTS_QUEUE_NAME` de
 * scripts/localstack-init/create-queues.sh.
 */
export const WAGER_TRANSACTION_EVENTS_QUEUE_NAME = 'wager-transaction-events.fifo';

/**
 * O payload salvo na Outbox nao tem `data.walletId` (formato invalido, ou
 * simplesmente nao e o envelope esperado). Isso nunca deveria acontecer —
 * todos os 4 eventos do Bloco 9a.2 sempre incluem `walletId` em `data` — mas
 * se acontecer, e um bug real, nao um erro transitorio de rede.
 */
export class InvalidOutboxPayloadError extends Error {
  constructor(outboxMessageId: string, details: string) {
    super(`Outbox message ${outboxMessageId} has an invalid payload: ${details}`);
    this.name = 'InvalidOutboxPayloadError';
  }
}

/**
 * `MessageGroupId` precisa ser a wallet, nao o `aggregate_id` bruto da
 * linha: `WagerTransactionProcessed`/`Rejected`/`PendingReference` usam
 * `aggregate_id = transactionId`, enquanto `WalletBalanceChanged` usa
 * `aggregate_id = walletId` — usar o `aggregate_id` direto quebraria a
 * ordem relativa entre esses dois fatos sobre a MESMA wallet. Todos os 4
 * eventos ja carregam `walletId` dentro de `data` (confirmado antes de
 * implementar isto), entao extrair de la e sempre possivel sem mudar schema.
 */
function extractWalletId(outboxMessageId: string, payload: Record<string, unknown>): string {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) {
    throw new InvalidOutboxPayloadError(outboxMessageId, 'payload.data ausente ou nao e um objeto');
  }
  const walletId = (data as Record<string, unknown>).walletId;
  if (typeof walletId !== 'string' || walletId.length === 0) {
    throw new InvalidOutboxPayloadError(outboxMessageId, 'payload.data.walletId ausente ou nao e string');
  }
  return walletId;
}

/**
 * Reivindica UMA linha due (FOR UPDATE SKIP LOCKED) e tenta publica-la —
 * tudo dentro da MESMA transacao. A transacao financeira original ja foi
 * commitada muito antes (Bloco 9a.2): este publisher so LE uma Outbox ja
 * persistida, nunca decide nada sobre saldo/ledger/WagerTransaction.
 *
 * Trade-off aceito para este MVP: o Postgres fica com essa UMA linha
 * travada (nunca um lock global) durante a chamada de rede ao SQS. Se o
 * `SendMessage` tiver sucesso mas o processo cair antes do commit desta
 * transacao, o evento JA foi entregue no SQS mas nossa contabilidade local
 * nao sabe disso — a proxima tentativa vai publicar de novo (duplicata real
 * de entrega). Isso e exatamente o cenario que o CHALLENGE.md (secao 11)
 * pede para funcionar: "uma publicacao duplicada continua segura para o
 * consumidor" — o `MessageDeduplicationId` estavel (o proprio id da
 * OutboxMessage) e a Inbox do lado de quem consome sao quem garantem isso,
 * nao esta funcao.
 *
 * Retorna `true` se encontrou e tratou (publicou ou reagendou) uma linha;
 * `false` se nao havia nenhuma devida agora.
 */
export async function publishDueOutboxMessage(
  em: EntityManager,
  client: SQSClient,
  queueUrl: string,
): Promise<boolean> {
  let claimed = false;

  await em.transactional(async (trxEm) => {
    const dueRow = await selectDueOutboxMessageForUpdate(trxEm);
    if (!dueRow) {
      return;
    }
    claimed = true;

    try {
      // payload invalido/sem walletId: nao publica, nem marca como
      // publicada — cai no mesmo catch de baixo, que reagenda a tentativa.
      const walletId = extractWalletId(dueRow.id, dueRow.payload);

      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(dueRow.payload),
          MessageGroupId: walletId,
          MessageDeduplicationId: dueRow.id,
        }),
      );

      await markOutboxMessagePublished(trxEm, dueRow.id);
    } catch (error) {
      logStructuredWarning('outbox_message_publish_failed', {
        outboxMessageId: dueRow.id,
        eventType: dueRow.event_type,
        attempts: dueRow.attempts,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      const nextAttemptNumber = dueRow.attempts + 1;
      await scheduleOutboxMessageRetry(trxEm, dueRow.id, computeOutboxNextAttemptDelaySeconds(nextAttemptNumber));
      outboxPublishRetriesTotal.inc({ event_type: dueRow.event_type });
    }
  });

  return claimed;
}
