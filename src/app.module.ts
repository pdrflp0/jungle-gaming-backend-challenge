import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config';
import { WageringModule } from './wagering/wagering.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WalletsModule, WageringModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
