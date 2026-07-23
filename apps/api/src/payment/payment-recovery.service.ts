import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertService } from '../operations/alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from './payment.service';

@Injectable()
export class PaymentRecoveryService {
  private readonly logger = new Logger(PaymentRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    @Optional() private readonly alerts: AlertService | null = null,
  ) {}

  /** 单笔认领租约时长：认领后 lastSyncedAt 至此不重复被其他实例拾取。 */
  private static readonly LEASE_MS = 5 * 60 * 1000;
  /** 恢复耗尽阈值：超过此时长仍未裁决终态视为异常，触发告警。 */
  private static readonly EXHAUST_MS = 2 * 60 * 60 * 1000;

  @Cron('0 */10 * * * *')
  async closeStaleOrders(now: Date = new Date()): Promise<void> {
    if (process.env.PAY_MODE !== 'wxpay') return;
    const cutoff = new Date(now.getTime() - 30 * 60 * 1000);
    const leaseCutoff = new Date(now.getTime() - PaymentRecoveryService.LEASE_MS);
    // 同时扫描 CREATED 与 PREPAY_UNKNOWN，两者都会占用账单、需查单裁决终态。
    const stale = await this.prisma.raw.payment.findMany({
      where: {
        channel: 'WXPAY',
        status: { in: ['CREATED', 'PREPAY_UNKNOWN'] },
        createdAt: { lt: cutoff },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: leaseCutoff } }],
      },
      select: { id: true, orderNo: true, lastSyncedAt: true, createdAt: true, status: true, tenantId: true, communityId: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    for (const payment of stale) {
      // 多实例租约：以 lastSyncedAt 做乐观锁认领，认领失败说明已被其他实例处理。
      const claimed = await this.prisma.raw.payment.updateMany({
        where: { id: payment.id, lastSyncedAt: payment.lastSyncedAt ?? null },
        data: { lastSyncedAt: now },
      });
      if (claimed.count !== 1) continue;
      try {
        await this.payments.reconcileStaleWxPay(payment.orderNo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`微信支付订单对账失败 order=${payment.orderNo}: ${message}`);
      }
      // 恢复耗尽：长期未裁决终态的订单触发告警（按订单号去重）。
      if (this.alerts && now.getTime() - payment.createdAt.getTime() > PaymentRecoveryService.EXHAUST_MS) {
        await this.alerts.safeEmit({
          tenantId: payment.tenantId,
          communityId: payment.communityId ?? null,
          alertType: 'STALE_PAYMENT',
          severity: 'WARNING',
          dedupKey: `STALE_PAYMENT:${payment.orderNo}`,
          title: '支付订单长时间未裁决终态',
          summary: `订单 ${payment.orderNo} 状态 ${payment.status} 超过恢复阈值仍未终态`,
        });
      }
    }
  }

}
