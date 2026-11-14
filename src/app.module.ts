import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { PayoutsModule } from './payouts/payouts.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SuperChatsModule } from './super-chats/super-chats.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    DatabaseModule,
    UsersModule,
    WalletModule,
    SuperChatsModule,
    PayoutsModule,
    AdminModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
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
