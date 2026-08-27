import { Controller, Get, Param } from '@nestjs/common';
import { GetWagerTransactionUseCase, WagerTransactionQueryResponse } from './get-wager-transaction.use-case';

/**
 * Controller separado do WageringController de proposito: a rota exigida
 * pela secao 9 do CHALLENGE.md comeca em /providers, nao em /wagering.
 */
@Controller('providers')
export class ProviderWageringController {
  constructor(private readonly getWagerTransaction: GetWagerTransactionUseCase) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async getByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionQueryResponse> {
    return this.getWagerTransaction.byProviderAndExternalId(providerId, externalTransactionId);
  }
}
