import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { ChatModule } from './chat/chat.module';
import { IS_SERVERLESS } from './config/app-config';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { PayoutsModule } from './payouts/payouts.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SuperChatsModule } from './super-chats/super-chats.module';
import { UiController } from './ui/ui.controller';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    DatabaseModule,
    UsersModule,
    WalletModule,
    SuperChatsModule,
    ChatModule,
    PayoutsModule,
    AdminModule,
    // WebSocket + LISTEN need a long-running process, which serverless doesn't have.
    // Super Chats still call pg_notify; with no listener the event is simply dropped.
    ...(IS_SERVERLESS ? [] : [RealtimeModule]),
  ],
  controllers: [HealthController, UiController],
  providers: [
    // Registered here rather than in main.ts so tests get the same validation.
    // Unknown body fields are rejected instead of silently dropped.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
