import { Controller, Get, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { resolveQueueUrl, WAGER_TRANSACTIONS_QUEUE_NAME } from '../wagering/sqs-client';

/** No maximo 2s por checagem — um dependencia lenta nao pode deixar /health/ready pendurado. */
const CHECK_TIMEOUT_MS = 2000;

type CheckResult = 'ok' | 'error';

/**
 * Corre `promise` normalmente, mas nunca espera mais que `ms`. O `.then`/
 * `.catch` fica sempre anexado a propria `promise` (nunca um Promise.race
 * descartando a promessa perdedora) — assim, se `promise` rejeitar DEPOIS do
 * timeout ja ter vencido, essa rejeicao ainda tem um handler e nunca vira
 * uma "unhandled rejection".
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * `GET /health/live` e `GET /health/ready` (CHALLENGE.md secoes 9 e 12).
 * Nunca exige autenticacao (nao ha nenhum guard registrado neste projeto).
 *
 * `live` nao consulta nenhuma dependencia de proposito: liveness so prova
 * que o processo Nest responde. Verificar Postgres/SQS aqui seria errado —
 * um orquestrador (Kubernetes ou equivalente) reiniciaria um processo
 * perfeitamente saudavel so porque uma dependencia externa caiu.
 *
 * `ready` verifica exatamente as duas dependencias que a secao 9 pede — Postgres
 * (`SELECT 1` no EntityManager ja injetado, sem abrir uma segunda conexao
 * global do MikroORM) e SQS (`GetQueueUrl` na fila `wager-transactions.fifo`).
 * Checar so essa fila, e nao as tres, e deliberado: o requisito e "SQS
 * alcancavel", nao "todas as filas existem" — e ela funciona independente de
 * `WAGER_TRANSACTIONS_CONSUMER_ENABLED`/`OUTBOX_PUBLISHER_ENABLED`, porque usa
 * seu proprio SQSClient (registrado no HealthModule), nunca o cliente do
 * consumidor ou do publisher.
 */
@Controller('health')
export class HealthController implements OnApplicationShutdown {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient: SQSClient,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<'postgres' | 'sqs', CheckResult> }> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const checks = { postgres, sqs };

    if (postgres === 'error' || sqs === 'error') {
      // Nunca vaza string de conexao, stack trace nem qualquer detalhe
      // sensivel — so ok/error por dependencia.
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }

  async onApplicationShutdown(): Promise<void> {
    this.sqsClient.destroy();
  }

  private async checkPostgres(): Promise<CheckResult> {
    try {
      await withTimeout(this.em.getConnection().execute('SELECT 1'), CHECK_TIMEOUT_MS, 'postgres');
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkSqs(): Promise<CheckResult> {
    try {
      await withTimeout(
        resolveQueueUrl(this.sqsClient, WAGER_TRANSACTIONS_QUEUE_NAME),
        CHECK_TIMEOUT_MS,
        'sqs',
      );
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
