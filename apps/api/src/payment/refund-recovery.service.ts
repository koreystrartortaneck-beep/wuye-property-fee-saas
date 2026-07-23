import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RefundService } from './refund.service';

/**
 * 退款恢复任务：扫描停留在 CREATED/PROCESSING 的退款聚合，
 * 以稳定 refundNo 查单直至终态；多实例经 lastQueriedAt 乐观锁租约认领。
 */
@Injectable()
export class RefundRecoveryService {
  private readonly logger = new Logger(RefundRecoveryService.name);
  private static readonly LEASE_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundService,
  ) {}

  @Cron('30 */10 * * * *')
  async recoverStaleRefunds(now: Date = new Date()): Promise<void> {
    if (process.env.PAY_MODE !== 'wxpay') return;
    const leaseCutoff = new Date(now.getTime() - RefundRecoveryService.LEASE_MS);
    const stale = await this.prisma.raw.refund.findMany({
      where: {
        channel: 'WXPAY',
        status: { in: ['CREATED', 'PROCESSING'] },
        OR: [{ lastQueriedAt: null }, { lastQueriedAt: { lt: leaseCutoff } }],
      },
      select: { id: true, refundNo: true, lastQueriedAt: true },
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
    }
  }
}
