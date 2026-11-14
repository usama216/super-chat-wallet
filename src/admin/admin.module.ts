import { Module } from '@nestjs/common';
import { PayoutsModule } from '../payouts/payouts.module';
import { SuperChatsModule } from '../super-chats/super-chats.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [SuperChatsModule, PayoutsModule],
  controllers: [AdminController],
})
export class AdminModule {}
