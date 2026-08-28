import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../wagering/sqs-client';
import { HealthController } from './health.controller';

/**
 * Um SQSClient proprio deste modulo, criado uma unica vez (provider
 * singleton do Nest) e reaproveitado em toda chamada a /health/ready —
 * nunca um cliente novo por requisicao, e nunca o cliente do consumidor
 * (Bloco 9b.2) ou do publisher (Bloco 9c), que só existem quando suas
 * proprias variaveis de ambiente ligam o polling deles.
 */
@Module({
  controllers: [HealthController],
  providers: [{ provide: SQSClient, useFactory: () => createSqsClient() }],
})
export class HealthModule {}
