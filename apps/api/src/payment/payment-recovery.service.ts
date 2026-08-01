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

  /*
   * 单笔认领租约：认领后 lastSyncedAt 至此不被其他实例重复拾取。
   * 90 秒（原 5 分钟）——
   * 配合 2 分钟一轮的扫描，一笔刚付款的订单最快能在 2 分钟内被查到并入账；
   * 5 分钟的租约会让它至少等 5 分钟才被复查。
   * 90 秒仍远大于一次查单的耗时（超时 15 秒），足以防两个实例重复处理。
   */
  private static readonly LEASE_MS = 90 * 1000;
  /** 查单起点：只读操作，越早越好 —— 业主付了钱就该尽快入账 */
  private static readonly QUERY_AFTER_MS = 2 * 60 * 1000;
  /** 关单起点：会作废订单并释放账单，业主可能还在收银台，必须等久一点 */
  private static readonly CLOSE_AFTER_MS = 30 * 60 * 1000;
  /** 恢复耗尽阈值：超过此时长仍未裁决终态视为异常，触发告警。 */
  private static readonly EXHAUST_MS = 2 * 60 * 60 * 1000;

  /*
   * 2 分钟一轮（原 10 分钟）。
   * 这是「业主付了钱但回调没到」时钱能自动入账的唯一保底路径 ——
   * 真实事故里业主等了 40 分钟：10 分钟一轮 × 只处理满 30 分钟的订单。
   */
  @Cron('0 */2 * * * *')
  async closeStaleOrders(now: Date = new Date()): Promise<void> {
    if (process.env.PAY_MODE !== 'wxpay') return;
    const cutoff = new Date(now.getTime() - PaymentRecoveryService.QUERY_AFTER_MS);
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
        // 够老才允许关单；年轻订单只查不关（业主可能还在收银台）
        const allowClose = now.getTime() - payment.createdAt.getTime() > PaymentRecoveryService.CLOSE_AFTER_MS;
        await this.payments.reconcileStaleWxPay(payment.orderNo, { allowClose });
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
