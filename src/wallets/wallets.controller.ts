import { Body, Controller, Post } from '@nestjs/common';
import { OpenWalletDto } from './dto/open-wallet.dto';
import { OpenWalletResult, OpenWalletUseCase } from './open-wallet.use-case';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly openWallet: OpenWalletUseCase) {}

  @Post()
  async open(@Body() dto: OpenWalletDto): Promise<OpenWalletResult> {
    return this.openWallet.execute(dto);
  }
}
