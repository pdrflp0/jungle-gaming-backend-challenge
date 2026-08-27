import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WagerTransactionEntity } from '../infra/database/entities/wager-transaction.entity';
import { WalletEntity } from '../infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../infra/database/entities/wallet-ledger-entry.entity';
import { GetWalletLedgerUseCase } from './get-wallet-ledger.use-case';
import { GetWalletUseCase } from './get-wallet.use-case';
import { OpenWalletUseCase } from './open-wallet.use-case';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [MikroOrmModule.forFeature([WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity])],
  controllers: [WalletsController],
  providers: [OpenWalletUseCase, GetWalletUseCase, GetWalletLedgerUseCase, ReconcileWalletUseCase],
})
export class WalletsModule {}
