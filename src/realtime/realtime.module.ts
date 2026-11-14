import { Module } from '@nestjs/common';
import { SuperChatsModule } from '../super-chats/super-chats.module';
import { StreamEventsListener } from './stream-events.listener';
import { StreamGateway } from './stream.gateway';

// realtime depends on super-chats, not the other way round: SuperChatsService only calls
// publishStreamEvent(), which is a plain SQL helper.
@Module({
  imports: [SuperChatsModule],
  providers: [StreamEventsListener, StreamGateway],
})
export class RealtimeModule {}
