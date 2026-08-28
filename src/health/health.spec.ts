import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { HealthController } from './health.controller';

describe('HealthController.live', () => {
  test('retorna ok sem tocar em nenhuma dependencia', () => {
    // objetos vazios: se `live()` tentasse consultar Postgres ou SQS, isso
    // estouraria aqui — a prova de que ele nao consulta nada e nao ter
    // nenhum metodo real para chamar.
    const controller = new HealthController({} as EntityManager, {} as SQSClient);

    expect(controller.live()).toEqual({ status: 'ok' });
  });
});
