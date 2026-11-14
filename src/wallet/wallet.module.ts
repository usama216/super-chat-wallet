import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { MockPaymentProvider, PAYMENT_PROVIDER } from './payment-provider';
import { PurchasesService } from './purchases.service';
import { WalletController } from './wallet.controller';

@Module({
  imports: [LedgerModule],
  controllers: [WalletController],
  providers: [PurchasesService, { provide: PAYMENT_PROVIDER, useClass: MockPaymentProvider }],
})
export class WalletModule {}
