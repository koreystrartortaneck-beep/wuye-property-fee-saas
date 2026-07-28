import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment/payment.module';
import { PaymentService } from '../payment/payment.service';
import { AdminReconciliationController, AdminReconciliationService } from './admin-reconciliation.controller';
import { RECON_RECOVERY, ReconciliationService } from './reconciliation.service';
import { WxPayDirectProvider } from '../payment/wxpay-direct.provider';
import { MockWechatBillProvider, WECHAT_BILL_PROVIDER, WechatBillProvider } from './wechat-bill.provider';
import { WxPayBillProvider } from './wxpay-bill.provider';

@Module({
  imports: [PaymentModule],
  controllers: [AdminReconciliationController],
  providers: [
    ReconciliationService,
    AdminReconciliationService,
    MockWechatBillProvider,
    WxPayDirectProvider,
    WxPayBillProvider,
    {
      /*
       * 对账单渠道按 PAY_MODE 选择，与 PAYMENT_PROVIDER 的选择方式保持一致。
       *
       * 这里原来无条件绑到 Mock，注释写着「真实适配器在生产 wxpay 模式接入」，
       * 但那个适配器从来没写过。结果生产上对账天天在跑、天天把本地交易全判成
       * 「微信侧缺失」，而真的资金差异一次也发现不了。
       *
       * 所以 wxpay 模式下**绝不允许**退回 Mock：宁可启动失败，也不要一个
       * 看起来在工作、实际什么都没对的对账。
       */
      provide: WECHAT_BILL_PROVIDER,
      inject: [MockWechatBillProvider, WxPayBillProvider],
      useFactory: (mock: MockWechatBillProvider, wxpay: WxPayBillProvider): WechatBillProvider => {
        if (process.env.PAY_MODE === 'wxpay') return wxpay;
        if (process.env.PAY_MODE === 'mock') {
          if (process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
            throw new Error('Mock 对账单渠道必须显式配置 ALLOW_MOCK_PAYMENTS=true');
          }
          return mock;
        }
        throw new Error('PAY_MODE 必须明确配置为 mock 或 wxpay');
      },
    },
    { provide: RECON_RECOVERY, useExisting: PaymentService },
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
