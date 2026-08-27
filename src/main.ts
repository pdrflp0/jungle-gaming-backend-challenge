import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // So a aplicacao real liga o worker de reprocessamento de PENDING_REFERENCE
  // (Bloco 7b) — os testes nunca setam esta variavel, entao o @Interval do
  // worker roda mas fica de fora (ver retry-pending-reference.worker.ts).
  process.env.PENDING_REFERENCE_WORKER_ENABLED ??= 'true';

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
