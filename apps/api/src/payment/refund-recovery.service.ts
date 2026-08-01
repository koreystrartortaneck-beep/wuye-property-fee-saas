import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AlertService } from '../operations/alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { RefundService } from './refund.service';

/**
 * 退款恢复任务：扫描停留在 CREATED/PROCESSING 的退款聚合，
 * 以稳定 refundNo 查单直至终态；多实例经 lastQueriedAt 乐观锁租约认领。
 */
@Injectable()
export class RefundRecoveryService {
  private readonly logger = new Logger(RefundRecoveryService.name);
  /*
   * 租约 90 秒（原 5 分钟）。配合 2 分钟一轮，一笔刚完成的退款最快 2 分钟内被对齐；
   * 5 分钟的租约会让它查过一次无果后再等 5 分钟。
   * 90 秒仍远大于一次查单耗时（超时 15 秒），足以防两个实例重复处理。
   */
  private static readonly LEASE_MS = 90 * 1000;
  /** 恢复耗尽阈值：退款超过此时长仍未终态视为异常，触发告警。 */
  private static readonly EXHAUST_MS = 2 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundService,
    @Optional() private readonly alerts: AlertService | null = null,
  ) {}

  /*
   * 2 分钟一轮（原 10 分钟）。
   *
   * 2026-08-01 实测：退款 15:20:28 发起，微信 15:20:30~33 就退完了（业主微信里已到账），
   * 而**退款回调一次都没到**，我们直到 15:30:30 的下一轮 cron 才发现 ——
   * 业主的钱已经回去了，后台却显示「退款中」，整整晚了 10 分钟。
   * 支付侧刚因为同样的形状改过（10 分钟 → 2 分钟），退款侧当时漏了。
   *
   * 查单是只读且幂等的，早查只有好处；退款没有「关单」这种破坏性动作，
   * 所以不需要像支付那样区分「早查单、晚关单」。
   */
  @Cron('0 */2 * * * *')
  async recoverStaleRefunds(now: Date = new Date()): Promise<void> {
    if (process.env.PAY_MODE !== 'wxpay') return;
    const leaseCutoff = new Date(now.getTime() - RefundRecoveryService.LEASE_MS);
    const stale = await this.prisma.raw.refund.findMany({
      where: {
        channel: 'WXPAY',
        // 含 FAILED/ABNORMAL：本地失败但微信侧可能已成功，需持续查单对齐
        status: { in: ['CREATED', 'PROCESSING', 'FAILED', 'ABNORMAL'] },
        OR: [{ lastQueriedAt: null }, { lastQueriedAt: { lt: leaseCutoff } }],
      },
      select: { id: true, refundNo: true, lastQueriedAt: true, requestedAt: true, status: true, tenantId: true, communityId: true },
      orderBy: { requestedAt: 'asc' },
      take: 100,
    });

    for (const refund of stale) {
      // 多实例租约：乐观锁认领，失败说明已被其他实例处理。
      const claimed = await this.prisma.raw.refund.updateMany({
        where: { id: refund.id, lastQueriedAt: refund.lastQueriedAt ?? null },
        data: { lastQueriedAt: now },
      });
      if (claimed.count !== 1) continue;
      try {
        await this.refunds.recoverRefund(refund.refundNo);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`退款恢复失败 refund=${refund.refundNo}: ${message}`);
      }
      // 恢复耗尽：长期未终态的退款触发告警（按退款单号去重）。
      if (this.alerts && now.getTime() - refund.requestedAt.getTime() > RefundRecoveryService.EXHAUST_MS) {
        await this.alerts.safeEmit({
          tenantId: refund.tenantId,
          communityId: refund.communityId ?? null,
          alertType: 'STALE_REFUND',
          severity: 'WARNING',
          dedupKey: `STALE_REFUND:${refund.refundNo}`,
          title: '退款长时间未终态',
          summary: `退款 ${refund.refundNo} 状态 ${refund.status} 超过恢复阈值仍未终态`,
        });
      }
    }
  }
}
