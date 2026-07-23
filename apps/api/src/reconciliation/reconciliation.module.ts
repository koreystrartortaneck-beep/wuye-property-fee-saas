import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment/payment.module';
import { PaymentService } from '../payment/payment.service';
import { AdminReconciliationController, AdminReconciliationService } from './admin-reconciliation.controller';
import { RECON_RECOVERY, ReconciliationService } from './reconciliation.service';
import { MockWechatBillProvider, WECHAT_BILL_PROVIDER } from './wechat-bill.provider';

@Module({
  imports: [PaymentModule],
  controllers: [AdminReconciliationController],
  providers: [
    ReconciliationService,
    AdminReconciliationService,
    MockWechatBillProvider,
    // 对账单渠道：非 wxpay / 本地测试用 Mock 适配器；真实微信下载适配器在生产 wxpay 模式接入。
    { provide: WECHAT_BILL_PROVIDER, useExisting: MockWechatBillProvider },
    { provide: RECON_RECOVERY, useExisting: PaymentService },
  ],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
