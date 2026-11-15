import { Module } from '@nestjs/common';
import { SuperChatsModule } from '../super-chats/super-chats.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [SuperChatsModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
