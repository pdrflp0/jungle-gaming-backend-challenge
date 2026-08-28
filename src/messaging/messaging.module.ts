import { Module } from '@nestjs/common';
import { OutboxPublisherWorker } from './outbox-publisher.worker';

@Module({
  providers: [OutboxPublisherWorker],
  exports: [OutboxPublisherWorker],
})
export class MessagingModule {}
