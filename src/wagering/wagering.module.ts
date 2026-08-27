import { Module } from '@nestjs/common';
import { RetryPendingReferenceWorker } from './retry-pending-reference.worker';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [SubmitWagerTransactionUseCase, RetryPendingReferenceWorker],
  exports: [RetryPendingReferenceWorker],
})
export class WageringModule {}
