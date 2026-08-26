import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WalletsModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
