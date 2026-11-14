import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { StreamsService } from './streams.service';
import { SuperChatsController } from './super-chats.controller';
import { SuperChatsService } from './super-chats.service';

@Module({
  imports: [LedgerModule],
  controllers: [SuperChatsController],
  providers: [StreamsService, SuperChatsService],
  exports: [StreamsService, SuperChatsService],
})
export class SuperChatsModule {}
