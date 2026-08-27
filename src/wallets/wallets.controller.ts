import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { resolveCorrelationId } from '../observability/correlation-id';
import { GetWalletLedgerQueryDto } from './dto/get-wallet-ledger-query.dto';
import { OpenWalletDto } from './dto/open-wallet.dto';
import { GetWalletLedgerResponse, GetWalletLedgerUseCase } from './get-wallet-ledger.use-case';
import { GetWalletResponse, GetWalletUseCase } from './get-wallet.use-case';
import { OpenWalletResult, OpenWalletUseCase } from './open-wallet.use-case';
import { ReconcileWalletUseCase, ReconciliationResponse } from './reconcile-wallet.use-case';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getWalletLedger: GetWalletLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  async open(
    @Body() dto: OpenWalletDto,
    @Headers('x-correlation-id') correlationIdHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OpenWalletResult> {
    const correlationId = resolveCorrelationId(correlationIdHeader);
    res.setHeader('X-Correlation-Id', correlationId);
    return this.openWallet.execute(dto, correlationId);
  }

  @Get(':walletId')
  async getById(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<GetWalletResponse> {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: GetWalletLedgerQueryDto,
  ): Promise<GetWalletLedgerResponse> {
    return this.getWalletLedger.execute(walletId, query.cursor, query.limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Headers('x-correlation-id') correlationIdHeader: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReconciliationResponse> {
    const correlationId = resolveCorrelationId(correlationIdHeader);
    res.setHeader('X-Correlation-Id', correlationId);
    return this.reconcileWallet.execute(walletId, correlationId);
  }
}
