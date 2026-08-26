import { Module } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [SubmitWagerTransactionUseCase],
})
export class WageringModule {}
