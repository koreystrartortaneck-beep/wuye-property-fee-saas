import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Bill } from '@prisma/client';
import { NotifyType } from '@pf/shared';
import { PrismaService } from '../prisma/prisma.service';
import { WX_API, WxApi } from '../wx/wx.service';
import {
  BillNotifier,
  DeliverableOutboxEvent,
  OutboxDeliveryOutcome,
  ReminderType,
} from './notify.tokens';
import { OutboxService } from './outbox.service';

/** Outbox 事件类型 → 微信订阅模板；未映射的事件（开票/支付/退款）暂无模板，投递时跳过。 */
const SUBSCRIBE_TEMPLATE_BY_EVENT: Record<string, NotifyType> = {
  'bill.published': 'BILL_CREATED',
  'bill.due_soon': 'DUE_SOON',
  'bill.overdue': 'OVERDUE',
};

/** 用户未订阅/拒收：不可重试，跳过即可（微信 43101 等）。 */
const SUBSCRIPTION_DENIED_RE = /43101|not\s*subscribed|未订阅|拒收|拒绝|reject/i;

/**
 * 账单通知服务（spec §6.3 / §10）。
 * - 找账单房屋的全部 ACTIVE 绑定用户逐一推送，写 NotifyLog
 * - 无绑定用户 → 记一条 SKIPPED（不阻塞出账）
 * - 提醒类按 (billId, type, SENT) 去重：每张账单每类提醒最多一次
 * - 显式使用 bill.tenantId 写日志（调用方上下文可能是调度器）
 */
@Injectable()
export class NotifyService implements BillNotifier {
  private readonly logger = new Logger('Notify');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WX_API) private readonly wx: WxApi,
    private readonly outbox: OutboxService,
  ) {}

  async onBillCreated(bill: Bill): Promise<void> {
    await this.send('BILL_CREATED', bill, false);
  }

  async onReminder(bill: Bill, type: ReminderType): Promise<void> {
    await this.send(type, bill, true);
  }

  private async send(type: NotifyType, bill: Bill, dedup: boolean): Promise<void> {
    if (dedup) {
      const sent = await this.prisma.raw.notifyLog.findFirst({
        where: { billId: bill.id, type, status: 'SENT' },
      });
      if (sent) return;
    }

    const bindings = await this.prisma.raw.houseBinding.findMany({
      where: { houseId: bill.houseId, status: 'ACTIVE' },
      include: { wxUser: { select: { id: true, openid: true } } },
    });

    if (bindings.length === 0) {
      await this.prisma.raw.notifyLog.create({
        data: { tenantId: bill.tenantId, billId: bill.id, type, channel: 'MOCK', status: 'SKIPPED', error: '房屋无绑定用户' },
      });
      return;
    }

    for (const binding of bindings) {
      const result = await this.wx
        .sendSubscribeMessage({
          openid: binding.wxUser.openid,
          templateType: type,
          data: {
            title: bill.title,
            amount: bill.amount.toString(),
            period: bill.period,
            dueDate: bill.dueDate.toISOString().slice(0, 10),
          },
        })
        .catch((e: Error) => ({ ok: false, error: e.message }));

      await this.prisma.raw.notifyLog.create({
        data: {
          tenantId: bill.tenantId,
          wxUserId: binding.wxUser.id,
          billId: bill.id,
          type,
          channel: process.env.WX_MODE === 'real' ? 'WX_SUBSCRIBE' : 'MOCK',
          status: result.ok ? 'SENT' : 'FAILED',
          error: result.ok ? null : (result as { error?: string }).error,
        },
      });
    }
    this.logger.log(`通知 ${type} bill=${bill.id} 推送 ${bindings.length} 人`);
  }

  /**
   * Outbox 事件投递（订阅消息适配器，可替换）。
   * - 事件无对应订阅模板（开票/支付/退款等）→ SKIPPED（不重试）；
   * - 收件人未订阅/拒收 → 该收件人跳过；全部跳过 → SKIPPED；
   * - 网络/暂时性错误 → RETRY（交由 Outbox 退避重试）。
   * 每个 Outbox 事件对应唯一收件人集合与单一渠道，投递一次成功即 PUBLISHED，不再被领取。
   */
  async deliverOutboxEvent(event: DeliverableOutboxEvent): Promise<OutboxDeliveryOutcome> {
    const templateType = SUBSCRIBE_TEMPLATE_BY_EVENT[event.eventType];
    if (!templateType) {
      this.logger.log(`Outbox 事件 ${event.eventType} 暂无订阅模板，跳过投递 event=${event.id}`);
      return 'SKIPPED';
    }
    const openids = await this.resolveRecipientOpenids(event);
    if (openids.length === 0) return 'SKIPPED';

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const data = {
      title: String(payload.title ?? payload.period ?? ''),
      amount: String(payload.amount ?? ''),
      period: String(payload.period ?? ''),
      dueDate: String(payload.dueDate ?? ''),
    };

    let delivered = 0;
    let retryable = false;
    for (const openid of openids) {
      const result = await this.wx
        .sendSubscribeMessage({ openid, templateType, data })
        .catch((e: Error) => ({ ok: false, error: e.message }));
      if (result.ok) {
        delivered += 1;
        continue;
      }
      const error = (result as { error?: string }).error ?? '';
      if (SUBSCRIPTION_DENIED_RE.test(error)) continue; // 未订阅：跳过，不重试
      retryable = true; // 其余失败视为可重试
    }
    if (retryable) return 'RETRY';
    return delivered > 0 ? 'DELIVERED' : 'SKIPPED';
  }

  /** 领取并投递一批 Outbox 事件；投递失败退避重试，业务事务不受影响。 */
  async dispatchOutboxBatch(input: {
    tenantId: string;
    workerId: string;
    limit?: number;
  }): Promise<{ delivered: number; skipped: number; retried: number }> {
    const claimed = await this.outbox.claimBatch({
      tenantId: input.tenantId,
      workerId: input.workerId,
      limit: input.limit,
    });
    const stats = { delivered: 0, skipped: 0, retried: 0 };
    for (const event of claimed) {
      const lease = { tenantId: input.tenantId, eventId: event.id, workerId: input.workerId, claimExpiresAt: event.claimExpiresAt! };
      let outcome: OutboxDeliveryOutcome;
      try {
        outcome = await this.deliverOutboxEvent(event as DeliverableOutboxEvent);
      } catch (error) {
        await this.outbox.markFailed({ ...lease, error });
        stats.retried += 1;
        continue;
      }
      if (outcome === 'RETRY') {
        await this.outbox.markFailed({ ...lease, error: '订阅消息投递暂时失败，稍后重试' });
        stats.retried += 1;
      } else {
        await this.outbox.markPublished(lease);
        if (outcome === 'DELIVERED') stats.delivered += 1;
        else stats.skipped += 1;
      }
    }
    return stats;
  }

  /** 定时投递（默认关闭，OUTBOX_DISPATCH_ENABLED=true 开启）。 */
  @Cron('30 * * * * *')
  async scheduledOutboxDispatch(): Promise<void> {
    if (process.env.OUTBOX_DISPATCH_ENABLED !== 'true') return;
    const workerId = `${process.env.HOSTNAME ?? 'notify'}-${process.pid}`;
    const tenants = await this.prisma.raw.outboxEvent.findMany({
      where: { status: { in: ['PENDING', 'FAILED', 'PROCESSING'] } },
      distinct: ['tenantId'],
      select: { tenantId: true },
      take: 100,
    });
    for (const { tenantId } of tenants) {
      try {
        await this.dispatchOutboxBatch({ tenantId, workerId });
      } catch (error) {
        this.logger.warn(`Outbox 投递失败 tenant=${tenantId}: ${(error as Error).message}`);
      }
    }
  }

  private async resolveRecipientOpenids(event: DeliverableOutboxEvent): Promise<string[]> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.aggregateType === 'Bill' && typeof payload.houseId === 'string') {
      const bindings = await this.prisma.raw.houseBinding.findMany({
        where: { houseId: payload.houseId, status: 'ACTIVE' },
        include: { wxUser: { select: { openid: true } } },
      });
      return [...new Set(bindings.map((b) => b.wxUser.openid))];
    }
    const wxUserId = typeof payload.wxUserId === 'string' ? payload.wxUserId : null;
    if (wxUserId) {
      const user = await this.prisma.raw.wxUser.findUnique({
        where: { id: wxUserId },
        select: { openid: true },
      });
      return user?.openid ? [user.openid] : [];
    }
    return [];
  }
}
