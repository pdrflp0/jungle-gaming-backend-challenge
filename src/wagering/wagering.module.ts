import { Module } from '@nestjs/common';
import { GetWagerTransactionUseCase } from './get-wager-transaction.use-case';
import { ProviderWageringController } from './provider-wagering.controller';
import { RetryPendingReferenceWorker } from './retry-pending-reference.worker';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController, ProviderWageringController],
  providers: [SubmitWagerTransactionUseCase, RetryPendingReferenceWorker, GetWagerTransactionUseCase],
  exports: [RetryPendingReferenceWorker],
})
export class WageringModule {}
