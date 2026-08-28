import { Module } from '@nestjs/common';
import { GetWagerTransactionUseCase } from './get-wager-transaction.use-case';
import { ProviderWageringController } from './provider-wagering.controller';
import { RetryPendingReferenceWorker } from './retry-pending-reference.worker';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { WageringController } from './wagering.controller';
import { WagerTransactionSqsConsumer } from './wager-transaction-sqs-consumer';

@Module({
  controllers: [WageringController, ProviderWageringController],
  providers: [
    SubmitWagerTransactionUseCase,
    RetryPendingReferenceWorker,
    GetWagerTransactionUseCase,
    WagerTransactionSqsConsumer,
  ],
  exports: [RetryPendingReferenceWorker, WagerTransactionSqsConsumer],
})
export class WageringModule {}
