import { Module } from '@nestjs/common';
import { InvoiceModule } from '../invoice/invoice.module';
import { AdminCollectionController } from './admin-collection.controller';
import { AdminPaymentController, AdminPaymentsService } from './admin-payment.controller';
import { AdminRefundController } from './admin-refund.controller';
import { CollectionPolicyService } from './collection-policy.service';
import { MockPaymentProvider } from './mock.provider';
import { OfflinePaymentService } from './offline-payment.service';
import { OwnerPaymentController } from './owner-payment.controller';
import { PaymentRecoveryService } from './payment-recovery.service';
import { PaymentService } from './payment.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './provider';
import { RefundRecoveryService } from './refund-recovery.service';
import { RefundService } from './refund.service';
import { WxPayDirectProvider } from './wxpay-direct.provider';
import { WxPayNotifyController } from './wxpay-notify.controller';
import { WxPayRefundNotifyController } from './wxpay-refund-notify.controller';
import { BILL_ORDER_CLOSER } from '../billing/bill-workflow.service';

@Module({
  imports: [InvoiceModule],
  controllers: [
    OwnerPaymentController,
    WxPayNotifyController,
    WxPayRefundNotifyController,
    AdminCollectionController,
    AdminRefundController,
    AdminPaymentController,
  ],
  providers: [
    PaymentService,
    CollectionPolicyService,
    RefundService,
    RefundRecoveryService,
    PaymentRecoveryService,
    OfflinePaymentService,
    AdminPaymentsService,
    { provide: BILL_ORDER_CLOSER, useExisting: PaymentService },
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
