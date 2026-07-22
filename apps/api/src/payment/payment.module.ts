import { Module } from '@nestjs/common';
import { MockPaymentProvider } from './mock.provider';
import { OwnerPaymentController } from './owner-payment.controller';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentService } from './payment.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './provider';
import { WxPayDirectProvider } from './wxpay-direct.provider';
import { WxPayNotifyController } from './wxpay-notify.controller';

@Module({
  controllers: [OwnerPaymentController, WxPayNotifyController],
  providers: [
    PaymentService,
    PaymentReconciliationService,
    MockPaymentProvider,
    WxPayDirectProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [MockPaymentProvider, WxPayDirectProvider],
      useFactory: (mock: MockPaymentProvider, wxpay: WxPayDirectProvider): PaymentProvider => {
        if (process.env.PAY_MODE === 'mock') {
          if (process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
            throw new Error('Mock 支付必须显式配置 ALLOW_MOCK_PAYMENTS=true');
          }
          return mock;
        }
        if (process.env.PAY_MODE === 'wxpay') {
          wxpay.assertConfigured();
          return wxpay;
        }
        throw new Error('PAY_MODE 必须明确配置为 mock 或 wxpay');
      },
    },
  ],
})
export class PaymentModule {}
