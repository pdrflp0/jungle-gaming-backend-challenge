import { UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import type { EntityManager } from '@mikro-orm/postgresql';
import { markInboxMessageProcessed, selectInboxMessage, tryClaimInboxMessage } from '../messaging/inbox.sql';
import { inboxDuplicatesDetectedTotal } from '../observability/metrics';
import { WagerTransactionRequestedMessageDto } from './dto/sqs-wager-transaction-message.dto';
import { computePayloadHash } from './payload-hash';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

export const WAGER_TRANSACTIONS_CONSUMER_NAME = 'wager-transactions-consumer';

export type ProcessWagerTransactionMessageResult = 'processed' | 'duplicate';

export class InvalidWagerTransactionMessageError extends Error {
  constructor(details: string) {
    super(`Invalid SQS message envelope: ${details}`);
    this.name = 'InvalidWagerTransactionMessageError';
  }
}

/**
 * O mesmo (consumerName, messageId) ja existe no Inbox, mas com um
 * payloadHash diferente — mensagem "veneno": alguem reenviou um messageId ja
 * usado com um corpo diferente. Nunca deve ser tratada como replay valido.
 */
export class ConflictingInboxPayloadError extends Error {
  constructor(messageId: string) {
    super(
      `Inbox message ${WAGER_TRANSACTIONS_CONSUMER_NAME}/${messageId} already exists with a different payload hash`,
    );
    this.name = 'ConflictingInboxPayloadError';
  }
}

/**
 * O (consumerName, messageId) existe no Inbox mas processedAt esta NULL. No
 * fluxo normal isso e IMPOSSIVEL: Inbox e o processamento financeiro sempre
 * commitam juntos (mesma transacao), entao uma linha so existe depois de
 * tudo ter sido concluido. Encontrar uma linha nao processada e um estado
 * anormal — nunca deve ser tratado como sucesso nem dar ACK silencioso.
 */
export class InconsistentInboxStateError extends Error {
  constructor(messageId: string) {
    super(
      `Inbox message ${WAGER_TRANSACTIONS_CONSUMER_NAME}/${messageId} exists but was never marked processed`,
    );
    this.name = 'InconsistentInboxStateError';
  }
}

function flattenValidationErrors(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => {
    const ownMessages = error.constraints ? Object.values(error.constraints) : [];
    const childMessages = error.children && error.children.length > 0 ? flattenValidationErrors(error.children) : [];
    return [...ownMessages, ...childMessages];
  });
}

function parseEnvelopeBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new InvalidWagerTransactionMessageError('message body is not valid JSON');
  }
}

async function validateEnvelope(parsed: unknown): Promise<WagerTransactionRequestedMessageDto> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidWagerTransactionMessageError('message body must be a JSON object');
  }

  const envelope = plainToInstance(WagerTransactionRequestedMessageDto, parsed);
  const errors = await validate(envelope, { whitelist: true, forbidNonWhitelisted: true });

  if (errors.length > 0) {
    throw new InvalidWagerTransactionMessageError(flattenValidationErrors(errors).join('; '));
  }

  return envelope;
}

/**
 * Nucleo transacional do consumidor SQS (Bloco 9b.1). Recebe o corpo cru da
 * mensagem e o EntityManager JA vinculado a transacao externa aberta pelo
 * chamador — esta funcao NUNCA abre a sua propria transacao. Inbox, o caso
 * de uso financeiro (reutilizado sem nenhuma alteracao) e a Outbox
 * compartilham exatamente o mesmo commit.
 *
 * So retorna 'processed' ou 'duplicate'. Qualquer outro caso (payload
 * invalido, hash conflitante, estado inconsistente, erro de infraestrutura
 * vindo do proprio caso de uso) lanca — nunca engole nem transforma falha em
 * sucesso silencioso. A decisao de dar ACK/DeleteMessage ou nao na mensagem
 * SQS pertence ao chamador (Bloco 9b.2), nao a esta funcao.
 */
export async function processWagerTransactionMessage(
  em: EntityManager,
  rawBody: string,
): Promise<ProcessWagerTransactionMessageResult> {
  const parsed = parseEnvelopeBody(rawBody);
  const envelope = await validateEnvelope(parsed);

  const { messageId, data } = envelope;
  const payloadHash = computePayloadHash(data);
  // correlationId = messageId do ENVELOPE do desafio, nunca o MessageId de
  // transporte que o SQS devolve — aquele pertence so a camada de
  // transporte futura (Bloco 9b.2), este e o identificador de negocio
  // estavel da mensagem.
  const correlationId = messageId;

  const claimed = await tryClaimInboxMessage(em, {
    messageId,
    consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME,
    payloadHash,
    receivedAt: new Date(),
  });

  if (!claimed) {
    const existing = await selectInboxMessage(em, WAGER_TRANSACTIONS_CONSUMER_NAME, messageId);

    if (!existing) {
      // Nao deveria ser alcancavel: nada neste projeto apaga linhas do
      // Inbox. Se o INSERT..ON CONFLICT nao retornou linha, uma linha
      // conflitante existe — se ela sumiu entre as duas leituras, e um
      // estado anormal, nao uma duplicata.
      throw new InconsistentInboxStateError(messageId);
    }
    if (existing.payload_hash !== payloadHash) {
      throw new ConflictingInboxPayloadError(messageId);
    }
    if (existing.processed_at === null) {
      throw new InconsistentInboxStateError(messageId);
    }

    inboxDuplicatesDetectedTotal.inc();
    return 'duplicate';
  }

  const useCase = new SubmitWagerTransactionUseCase(em);

  try {
    await useCase.execute(data.idempotencyKey, data, correlationId);
  } catch (error) {
    if (!(error instanceof UnprocessableEntityException)) {
      throw error;
    }
    // Rejeicao de negocio: a transacao ja commitou (dentro do savepoint do
    // proprio caso de uso) com um resultado REJECTED valido, auditavel —
    // nao e uma falha do processamento da mensagem em si.
  }

  await markInboxMessageProcessed(em, WAGER_TRANSACTIONS_CONSUMER_NAME, messageId, new Date());

  return 'processed';
}
