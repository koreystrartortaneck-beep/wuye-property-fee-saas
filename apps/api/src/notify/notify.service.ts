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
import { buildSubscribeData } from './subscribe-fields';

/** Outbox 事件类型 → 微信订阅模板；未映射的事件（开票/支付/退款）暂无模板，投递时跳过。 */
const SUBSCRIBE_TEMPLATE_BY_EVENT: Record<string, NotifyType> = {
  'bill.published': 'BILL_CREATED',
  'bill.due_soon': 'DUE_SOON',
  'bill.overdue': 'OVERDUE',
};

/**
 * 用户未订阅/额度不足：不可重试，跳过即可（微信 43101 等）。
 *
 * 注意必须同时匹配翻译后的中文文案——wx.real 会把 43101 转成
 * 「业主没有可用的订阅额度…（微信原文：43101 …）」，原文仍在括号里，
 * 所以数字 43101 依然能命中；但若哪天翻译改成不带原文，这里会漏判成「可重试」，
 * 于是一条永远发不出去的通知会被反复重试到耗尽。加「订阅额度」一并兜住。
 */
const SUBSCRIPTION_DENIED_RE = /43101|订阅额度|not\s*subscribed|未订阅|拒收|拒绝|reject/i;

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
    // 一律去重。原先传 false，与 Outbox 的 bill.published 形成两条无条件发送的
    // 并行路径，而「一次性订阅」一次授权只能发一条：两条路径抢同一份额度，
    // 后到的那条必得 43101。生产 NotifyLog 里 BILL_CREATED 零条 SENT、4 条
    // 43101 FAILED，正是这么来的——业主从未收到过出账通知。
    await this.send('BILL_CREATED', bill, true);
  }

  async onReminder(bill: Bill, type: ReminderType): Promise<void> {
    await this.send(type, bill, true);
  }

  /**
   * 唯一的投递实现：解析收件人 → 发送 → 写 NotifyLog。
   *
   * 返回 Outbox 语义的结果，好让 Outbox 投递复用同一份实现。此前 Outbox 走的是
   * 另一套代码，导致三处不一致：
   *   1) 它完全不查 NotifyLog，既不去重也不留痕——「通知记录」页看不到经 Outbox
   *      发出的任何一条，物业无法判断业主到底收到没有；
   *   2) 它从 event.payload 取 title/dueDate，而 bill.published 的 payload 只有
   *      billId/houseId/period/amount。于是费用名称退化成账期（「2026-07」），
   *      dueDate 为空串 → formatDueDate 返回空 → 微信判 47003 参数非法 →
   *      被判可重试 → 重试 5 次后触发 CRITICAL 告警。现在被 43101 掩盖着，
   *      业主一旦有额度就会立刻暴露；
   *   3) 两套代码各自演进，模板字段映射改一处漏一处。
   */
  private async send(type: NotifyType, bill: Bill, dedup: boolean): Promise<OutboxDeliveryOutcome> {
    if (dedup) {
      const sent = await this.prisma.raw.notifyLog.findFirst({
        where: { billId: bill.id, type, status: 'SENT' },
      });
      if (sent) return 'SKIPPED';
    }

    const bindings = await this.prisma.raw.houseBinding.findMany({
      where: { houseId: bill.houseId, status: 'ACTIVE' },
      include: { wxUser: { select: { id: true, openid: true } } },
    });

    if (bindings.length === 0) {
      await this.prisma.raw.notifyLog.create({
        data: { tenantId: bill.tenantId, billId: bill.id, type, channel: 'MOCK', status: 'SKIPPED', error: '房屋无绑定用户' },
      });
      return 'SKIPPED';
    }

    /*
     * 按 openid 去重。同一个微信号可能对同一房屋有多条 ACTIVE 绑定（例如先手机号
     * 自动匹配、后又手工提交过一次），逐条发会让业主收到重复消息，并且白白吃掉
     * 「一次性订阅」的额度——额度是按人算的，发两条就要两次授权。
     * 原 Outbox 投递路径做了这个去重，本方法没有；合并两条路径时必须保留。
     */
    const seenOpenids = new Set<string>();
    const recipients = bindings.filter((b) => {
      if (seenOpenids.has(b.wxUser.openid)) return false;
      seenOpenids.add(b.wxUser.openid);
      return true;
    });

    let delivered = 0;
    let retryable = false;
    for (const binding of recipients) {
      const result = await this.wx
        .sendSubscribeMessage({
          openid: binding.wxUser.openid,
          templateType: type,
          // data 的键必须是微信模板字段名（thing1/amount2/…），不是业务语义名，
          // 否则微信一律判 47003 参数非法。映射集中在 subscribe-fields.ts。
          data: buildSubscribeData(type, {
            title: bill.title,
            amount: bill.amount.toString(),
            // 传 Date：到期日期要按上海时区格式化，切 ISO 字符串会少算一天
            dueDate: bill.dueDate,
          }),
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

      if (result.ok) {
        delivered += 1;
        continue;
      }
      // 未订阅/额度不足是业主的选择，重试也没用；其余（网络、微信侧抖动）才重试。
      if (!SUBSCRIPTION_DENIED_RE.test((result as { error?: string }).error ?? '')) retryable = true;
    }
    this.logger.log(`通知 ${type} bill=${bill.id} 推送 ${recipients.length} 人，成功 ${delivered}`);
    if (retryable) return 'RETRY';
    return delivered > 0 ? 'DELIVERED' : 'SKIPPED';
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
    // 三个有模板的事件都是账单类。从库里取账单而不是读 payload：payload 缺
    // title/dueDate，且即使补上也会与账单后续变更（改期、调额）脱节。
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const billId = typeof payload.billId === 'string' ? payload.billId : null;
    if (event.aggregateType !== 'Bill' || !billId) {
      this.logger.warn(`Outbox 事件缺少 billId，无法投递 event=${event.id}`);
      return 'SKIPPED';
    }
    const bill = await this.prisma.raw.bill.findUnique({ where: { id: billId } });
    if (!bill) {
      // 账单已被物理删除（正常流程不会发生）：重试无意义
      this.logger.warn(`Outbox 事件对应账单不存在，跳过 event=${event.id} bill=${billId}`);
      return 'SKIPPED';
    }
    return this.send(templateType, bill, true);
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

  /**
   * 定时投递（默认**开启**，需显式 OUTBOX_DISPATCH_ENABLED=false 才停）。
   *
   * 原来是默认关闭、要配 OUTBOX_DISPATCH_ENABLED=true 才跑。生产上没配这个变量，
   * 于是这个任务从未执行过一次：事件只进不出，实测积压 24 条、80 秒内纹丝不动，
   * 而后台没有任何地方提示「投递是关着的」。
   *
   * 通知投递是核心链路，不该以「配了才生效」的方式存在。本地开发不想真发消息
   * 应当靠 WX_MODE=mock 控制，而不是把整条投递管道关掉。
   */
  @Cron('30 * * * * *')
  async scheduledOutboxDispatch(): Promise<void> {
    if (process.env.OUTBOX_DISPATCH_ENABLED === 'false') return;
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

}
