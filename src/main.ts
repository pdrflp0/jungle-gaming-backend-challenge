import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // So a aplicacao real liga o worker de reprocessamento de PENDING_REFERENCE
  // (Bloco 7b) — os testes nunca setam esta variavel, entao o @Interval do
  // worker roda mas fica de fora (ver retry-pending-reference.worker.ts).
  process.env.PENDING_REFERENCE_WORKER_ENABLED ??= 'true';
  // Mesmo padrao para o consumidor SQS (Bloco 9b.2) — desligado por padrao,
  // testes que nao sao dele nunca setam esta variavel e nao precisam do
  // LocalStack no ar (ver wager-transaction-sqs-consumer.ts).
  process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED ??= 'true';
  // Mesmo padrao para o publisher da Outbox (Bloco 9c) — desligado por
  // padrao, testes que nao sao dele nunca setam esta variavel (ver
  // outbox-publisher.worker.ts).
  process.env.OUTBOX_PUBLISHER_ENABLED ??= 'true';

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  // Sem isso o Nest nunca escuta SIGTERM/SIGINT — o shutdown gracioso do
  // consumidor SQS (onApplicationShutdown) nunca dispararia.
  app.enableShutdownHooks();
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
