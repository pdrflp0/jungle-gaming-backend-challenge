import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { createSqsClient, resolveQueueUrl } from '../wagering/sqs-client';
import { publishDueOutboxMessage, WAGER_TRANSACTION_EVENTS_QUEUE_NAME } from './outbox-publisher';

/** Sem long-poll aqui (isto e Postgres, nao SQS) — so um intervalo curto entre tentativas vazias. */
const POLL_INTERVAL_MS = 1000;

/**
 * Desligado por padrao. `src/main.ts` liga explicitamente para a aplicacao
 * real. Nenhum teste que nao seja deste publisher seta essa variavel, entao
 * `onModuleInit` sempre retorna sem fazer nada — nenhum outro teste precisa
 * do LocalStack no ar por causa deste worker.
 */
function isPublisherEnabled(): boolean {
  return process.env.OUTBOX_PUBLISHER_ENABLED === 'true';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Publisher real da Outbox (Bloco 9c). Todo o trabalho de reivindicar e
 * publicar uma linha ja foi construido e testado em isolamento em
 * `outbox-publisher.ts` (`publishDueOutboxMessage`) — este arquivo so
 * decide QUANDO chamar isso: continuamente, drenando o quanto houver
 * pendente, com uma pausa curta quando nao ha nada a fazer.
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private client: SQSClient | undefined;
  private queueUrl: string | undefined;
  private shuttingDown = false;
  private loopPromise: Promise<void> | undefined;

  constructor(private readonly em: EntityManager) {}

  async onModuleInit(): Promise<void> {
    if (!isPublisherEnabled()) {
      return;
    }
    this.client = createSqsClient();
    this.queueUrl = await resolveQueueUrl(this.client, WAGER_TRANSACTION_EVENTS_QUEUE_NAME);
    this.loopPromise = this.pollLoop();
  }

  /**
   * Impede novos ciclos (o loop nunca inicia outra tentativa depois disso) e
   * espera o ciclo atual — vazio ou publicando uma linha — terminar sozinho
   * antes de fechar o cliente SQS. Nunca encerra a aplicacao no meio de uma
   * transacao.
   */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.loopPromise;
    this.client?.destroy();
  }

  private async pollLoop(): Promise<void> {
    while (!this.shuttingDown) {
      const processed = await this.publishOnce();
      if (!processed) {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  /**
   * Um unico ciclo: reivindica e trata (publica ou reagenda) no maximo uma
   * linha. Exposto separadamente do loop continuo para os testes chamarem
   * diretamente, sem depender do `while` nem de temporizacao.
   */
  async publishOnce(): Promise<boolean> {
    if (!this.client || !this.queueUrl) {
      return false;
    }
    return publishDueOutboxMessage(this.em, this.client, this.queueUrl);
  }
}
