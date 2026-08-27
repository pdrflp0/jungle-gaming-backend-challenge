import { UnderscoreNamingStrategy } from '@mikro-orm/core';
import { defineConfig } from '@mikro-orm/postgresql';
import { InboxMessageEntity } from './src/infra/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from './src/infra/database/entities/outbox-message.entity';
import { WagerTransactionEntity } from './src/infra/database/entities/wager-transaction.entity';
import { WalletEntity } from './src/infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from './src/infra/database/entities/wallet-ledger-entry.entity';

export default defineConfig({
  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
  namingStrategy: UnderscoreNamingStrategy,
  dbName: process.env.POSTGRES_DB ?? 'jungle_gaming',
  user: process.env.POSTGRES_USER ?? 'app',
  password: process.env.POSTGRES_PASSWORD ?? 'app',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  migrations: {
    path: 'src/infra/database/migrations',
    pathTs: 'src/infra/database/migrations',
  },
});
