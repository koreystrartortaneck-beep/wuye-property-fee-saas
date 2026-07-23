import { Module } from '@nestjs/common';
import { AdminCollectionController } from './admin-collection.controller';
import { AdminRefundController } from './admin-refund.controller';
import { CollectionPolicyService } from './collection-policy.service';
import { MockPaymentProvider } from './mock.provider';
import { OwnerPaymentController } from './owner-payment.controller';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentService } from './payment.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './provider';
import { RefundRecoveryService } from './refund-recovery.service';
import { RefundService } from './refund.service';
import { WxPayDirectProvider } from './wxpay-direct.provider';
import { WxPayNotifyController } from './wxpay-notify.controller';
import { WxPayRefundNotifyController } from './wxpay-refund-notify.controller';

@Module({
  controllers: [
    OwnerPaymentController,
    WxPayNotifyController,
    WxPayRefundNotifyController,
    AdminCollectionController,
    AdminRefundController,
  ],
  providers: [
    PaymentService,
    CollectionPolicyService,
    RefundService,
    RefundRecoveryService,
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
  exports: [PaymentService, RefundService],
})
export class PaymentModule {}
