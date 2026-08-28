import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { wagerTransactionProcessingDurationSeconds } from '../observability/metrics';
import { logStructuredWarning } from '../observability/structured-logger';
import {
  ConflictingInboxPayloadError,
  InconsistentInboxStateError,
  InvalidWagerTransactionMessageError,
  processWagerTransactionMessage,
} from './process-wager-transaction-message';
import { createSqsClient, resolveQueueUrl, WAGER_TRANSACTIONS_QUEUE_NAME } from './sqs-client';

/**
 * Maximo permitido pelo SQS (20s) por padrao — reduz o numero de polls
 * vazios sem custar nada em producao. So os testes deste consumidor
 * sobrescrevem isso (para um valor bem menor), exatamente para que o
 * shutdown de um poll vazio entre um teste e outro nao demore ate 20s de
 * verdade — nao existe forma segura de cancelar um long-poll do SQS ja em
 * andamento no meio do caminho sem arriscar "perder" uma mensagem que o
 * servidor ja tenha selecionado no instante exato do cancelamento.
 *
 * Funcao, nao `const` de topo: precisa ler a variavel de ambiente A CADA
 * chamada, nao uma unica vez no carregamento do modulo — o teste so seta
 * essa variavel dentro do seu `beforeAll`, que roda DEPOIS que este arquivo
 * ja foi importado.
 */
function getWaitTimeSeconds(): number {
  return Number(process.env.WAGER_TRANSACTIONS_SQS_WAIT_TIME_SECONDS ?? 20);
}

/** Uma mensagem por vez: mesma filosofia do worker de PENDING_REFERENCE (Bloco 7b) — uma transacao curta, um lock de wallet por vez. */
const MAX_NUMBER_OF_MESSAGES = 1;

/**
 * Desligado por padrao. `src/main.ts` liga explicitamente para a aplicacao
 * real. Nenhum teste que nao seja deste consumidor seta essa variavel, entao
 * `onModuleInit` sempre retorna sem fazer nada nesses casos — nenhum outro
 * teste precisa de LocalStack no ar.
 */
function isConsumerEnabled(): boolean {
  return process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED === 'true';
}

/**
 * Consumidor real de `wager-transactions.fifo` (Bloco 9b.2). Todo o trabalho
 * financeiro/transacional (Inbox, caso de uso, Outbox, atomicidade) ja foi
 * construido e testado no Bloco 9b.1 (`processWagerTransactionMessage`) —
 * este arquivo so decide, com base no resultado dela, se a mensagem pode ser
 * apagada da fila. Nenhuma logica de retry em memoria: o unico mecanismo de
 * nova tentativa e o proprio SQS (visibility timeout + RedrivePolicy da
 * DLQ, ja provisionados no Bloco 9a.3).
 */
@Injectable()
export class WagerTransactionSqsConsumer implements OnModuleInit, OnApplicationShutdown {
  private client: SQSClient | undefined;
  private queueUrl: string | undefined;
  private shuttingDown = false;
  private loopPromise: Promise<void> | undefined;

  constructor(private readonly em: EntityManager) {}

  async onModuleInit(): Promise<void> {
    if (!isConsumerEnabled()) {
      return;
    }
    this.client = createSqsClient();
    this.queueUrl = await resolveQueueUrl(this.client, WAGER_TRANSACTIONS_QUEUE_NAME);
    this.loopPromise = this.pollLoop();
  }

  /**
   * Impede novos polls (o loop nunca inicia outro ReceiveMessage depois
   * disso) e espera a iteracao atual — receive vazio ou mensagem em
   * processamento — terminar sozinha antes de fechar o cliente SQS. Nunca
   * encerra a aplicacao no meio de uma transacao. Deliberadamente NAO
   * cancela um long-poll ja em andamento: nao existe forma segura de fazer
   * isso sem arriscar "perder" uma mensagem que o SQS ja tenha selecionado
   * no instante exato do cancelamento — o pior caso e esperar ate
   * WaitTimeSeconds por um poll vazio, o que e aceitavel.
   */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.loopPromise;
    this.client?.destroy();
  }

  private async pollLoop(): Promise<void> {
    while (!this.shuttingDown) {
      await this.pollOnce();
    }
  }

  /**
   * Uma unica iteracao: um ReceiveMessage e, se veio alguma coisa, um
   * processamento completo. Exposto separadamente do loop continuo para os
   * testes chamarem diretamente, sem depender do `while` nem de temporizacao.
   */
  async pollOnce(): Promise<void> {
    if (!this.client || !this.queueUrl) {
      return;
    }

    const { Messages } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: MAX_NUMBER_OF_MESSAGES,
        WaitTimeSeconds: getWaitTimeSeconds(),
      }),
    );

    if (!Messages || Messages.length === 0) {
      return;
    }

    await this.handleMessage(Messages[0]);
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.Body === undefined || message.ReceiptHandle === undefined) {
      return;
    }
    const rawBody = message.Body;
    const receiptHandle = message.ReceiptHandle;

    // Latencia sempre observada em `finally` — sucesso ou erro. `messageId`
    // do envelope nunca vira label (alta cardinalidade); so `source`/`outcome`.
    const stopTimer = wagerTransactionProcessingDurationSeconds.startTimer({ source: 'sqs' });
    let outcome: 'success' | 'error' = 'success';
    try {
      // Cada mensagem roda na sua PROPRIA transacao: em.transactional() cria
      // um fork novo a cada chamada (nunca reaproveita a transacao/conexao
      // de uma mensagem anterior) — a mesma garantia ja provada no Bloco
      // 9a.2/9b.1, so chamada aqui de novo por mensagem.
      await this.em.transactional((em) => processWagerTransactionMessage(em, rawBody));
      // 'processed' ou 'duplicate' — os dois casos apagam. Uma rejeicao de
      // negocio ja e 'processed' dentro do proprio nucleo do 9b.1, entao
      // tambem apaga aqui: a transacao ja commitou um resultado valido.
      await this.deleteMessage(receiptHandle);
    } catch (error) {
      outcome = 'error';
      this.logProcessingFailure(error, message);
      // NUNCA apaga aqui. O SQS cuida de reentrega (visibility timeout) e,
      // apos maxReceiveCount=5, da DLQ — nenhum retry em memoria neste codigo.
    } finally {
      stopTimer({ outcome });
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    if (!this.client || !this.queueUrl) {
      return;
    }
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
  }

  private logProcessingFailure(error: unknown, message: Message): void {
    const reason =
      error instanceof InvalidWagerTransactionMessageError
        ? 'invalid_payload'
        : error instanceof ConflictingInboxPayloadError
          ? 'conflicting_payload'
          : error instanceof InconsistentInboxStateError
            ? 'inconsistent_inbox_state'
            : 'processing_error';

    logStructuredWarning('wager_transaction_sqs_message_not_acked', {
      reason,
      sqsMessageId: message.MessageId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
