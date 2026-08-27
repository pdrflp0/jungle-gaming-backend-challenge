import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SubmitWagerTransactionDto } from './dto/submit-wager-transaction.dto';
import { GetWagerTransactionUseCase, WagerTransactionQueryResponse } from './get-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

@Controller('wagering')
export class WageringController {
  constructor(
    private readonly useCase: SubmitWagerTransactionUseCase,
    private readonly getWagerTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.useCase.execute(idempotencyKey, dto);
    res.status(result.httpStatus);
    return result.body;
  }

  @Get('transactions/:transactionId')
  async getById(@Param('transactionId', ParseUUIDPipe) transactionId: string): Promise<WagerTransactionQueryResponse> {
    return this.getWagerTransaction.byId(transactionId);
  }
}
