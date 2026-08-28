import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';
import { AppModule } from '../app.module';
import { createSqsClient } from '../wagering/sqs-client';
import { HealthController } from './health.controller';

/**
 * Integracao real do modulo de health (Bloco de health checks): o caminho
 * feliz de /health/live e /health/ready sobe a aplicacao Nest inteira e
 * fala com Postgres/LocalStack de verdade — nenhuma outra suite de teste do
 * projeto muda de comportamento por causa disto.
 *
 * As ramificacoes de FALHA usam dependencias simuladas (um EntityManager e
 * um SQSClient falsos, que rejeitam imediatamente) em vez de esperar uma
 * conexao de verdade nunca responder — instrucao explicita para evitar
 * testes lentos/frageis. O controller e construido diretamente (sem
 * DI/HTTP), mesmo padrao ja usado em todo o projeto para testar um caso de
 * uso isoladamente.
 *
 * Sem sufixo .spec./.test. de proposito — roda so via `bun run test:integration`.
 */

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address !== null ? address.port : address;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

function buildFailingEntityManager(): EntityManager {
  return {
    getConnection: () => ({
      execute: () => Promise.reject(new Error('simulated postgres failure')),
    }),
  } as unknown as EntityManager;
}

function buildFailingSqsClient(): SQSClient {
  return {
    send: () => Promise.reject(new Error('simulated sqs failure')),
  } as unknown as SQSClient;
}

describe('GET /health/live', () => {
  test('sempre 200, mesmo sem checar nada', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready — caminho feliz (Postgres e LocalStack reais)', () => {
  test('200 com os dois checks ok, independente de WAGER_TRANSACTIONS_CONSUMER_ENABLED/OUTBOX_PUBLISHER_ENABLED', async () => {
    // este arquivo nunca seta essas duas variaveis — a app sobe com os dois
    // workers desligados (o padrao de todo teste), e a readiness ainda
    // precisa funcionar normalmente.
    expect(process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED).toBeUndefined();
    expect(process.env.OUTBOX_PUBLISHER_ENABLED).toBeUndefined();

    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'ok', sqs: 'ok' } });
  });
});

describe('GET /health/ready — ramificacoes de falha (dependencias simuladas)', () => {
  let realOrm: MikroORM;
  let realSqsClient: SQSClient;

  beforeAll(async () => {
    realOrm = await MikroORM.init(config);
    realSqsClient = createSqsClient();
  });

  afterAll(async () => {
    realSqsClient.destroy();
    await realOrm.close();
  });

  test('Postgres falha, SQS ok: 503 com checks corretos, sem vazar detalhe sensivel', async () => {
    const controller = new HealthController(buildFailingEntityManager(), realSqsClient);

    let caught: unknown;
    try {
      await controller.ready();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    const exception = caught as ServiceUnavailableException;
    expect(exception.getStatus()).toBe(503);
    expect(exception.getResponse()).toEqual({ status: 'error', checks: { postgres: 'error', sqs: 'ok' } });

    const responseText = JSON.stringify(exception.getResponse());
    expect(responseText).not.toContain('simulated postgres failure'); // nunca a mensagem de erro crua
    expect(responseText.toLowerCase()).not.toContain('password');
  });

  test('SQS falha, Postgres ok: 503 com checks corretos', async () => {
    const controller = new HealthController(realOrm.em.fork(), buildFailingSqsClient());

    let caught: unknown;
    try {
      await controller.ready();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    const exception = caught as ServiceUnavailableException;
    expect(exception.getStatus()).toBe(503);
    expect(exception.getResponse()).toEqual({ status: 'error', checks: { postgres: 'ok', sqs: 'error' } });
  });

  test('ambos falham: 503 com os dois checks marcados error', async () => {
    const controller = new HealthController(buildFailingEntityManager(), buildFailingSqsClient());

    let caught: unknown;
    try {
      await controller.ready();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect((caught as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { postgres: 'error', sqs: 'error' },
    });
  });
});
