import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from './payment.service';

@Injectable()
export class PaymentRecoveryService {
  private readonly logger = new Logger(PaymentRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
  ) {}

  /** 单笔认领租约时长：认领后 lastSyncedAt 至此不重复被其他实例拾取。 */
  private static readonly LEASE_MS = 5 * 60 * 1000;

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
      select: { id: true, orderNo: true, lastSyncedAt: true },
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
    }
  }

}
