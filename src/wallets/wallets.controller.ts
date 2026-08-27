import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { GetWalletLedgerQueryDto } from './dto/get-wallet-ledger-query.dto';
import { OpenWalletDto } from './dto/open-wallet.dto';
import { GetWalletLedgerResponse, GetWalletLedgerUseCase } from './get-wallet-ledger.use-case';
import { GetWalletResponse, GetWalletUseCase } from './get-wallet.use-case';
import { OpenWalletResult, OpenWalletUseCase } from './open-wallet.use-case';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getWalletLedger: GetWalletLedgerUseCase,
  ) {}

  @Post()
  async open(@Body() dto: OpenWalletDto): Promise<OpenWalletResult> {
    return this.openWallet.execute(dto);
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
}
