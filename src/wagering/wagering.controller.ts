import { BadRequestException, Body, Controller, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SubmitWagerTransactionDto } from './dto/submit-wager-transaction.dto';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

@Controller('wagering')
export class WageringController {
  constructor(private readonly useCase: SubmitWagerTransactionUseCase) {}

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
}
