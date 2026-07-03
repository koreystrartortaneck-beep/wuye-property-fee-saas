import { Module } from '@nestjs/common';
import { MockPaymentProvider } from './mock.provider';
import { OwnerPaymentController } from './owner-payment.controller';
import { PaymentService } from './payment.service';
import { PAYMENT_PROVIDER } from './provider';

@Module({
  controllers: [OwnerPaymentController],
  providers: [
    PaymentService,
    // PAY_MODE=wxpay 时在子项目 5 替换为微信服务商 Provider
    { provide: PAYMENT_PROVIDER, useClass: MockPaymentProvider },
  ],
})
export class PaymentModule {}
