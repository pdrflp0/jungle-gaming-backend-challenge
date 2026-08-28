import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { MetricsController } from './metrics.controller';

/**
 * Importa HealthModule so para reaproveitar o SQSClient ja exportado por
 * ele (dedicado, ciclo de vida da app) — evita abrir um segundo cliente SQS
 * so para a checagem de profundidade da DLQ.
 */
@Module({
  imports: [HealthModule],
  controllers: [MetricsController],
})
export class MetricsModule {}
