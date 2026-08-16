import { Inject, Injectable, Logger } from '@nestjs/common';
import { BILL_STATUS_CN, ErrorCode, PAYMENT_STATUS_CN, cn } from '@pf/shared';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CouponsService } from '../coupons/coupons.service';
import { toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { CollectionPolicyService } from './collection-policy.service';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, WxPayTransaction } from './provider';

/** 进行中订单（占用账单）的状态集合 */
const ACTIVE_PAYMENT_STATUSES = ['CREATED', 'PREPAY_UNKNOWN'] as const;

/** 可入账的订单行（回调与查单两条路径传进来的都是完整 Payment 行） */
type SettleablePayment = {
  id: string;
  orderNo: string;
  status: string;
  transactionId: string | null;
  channel: string;
  totalAmount: unknown;
  // 审计需要租户与小区归属；调用方传的都是完整的 Payment 行，本就带这两列
  tenantId: string;
  communityId: string | null;
  // 自动发券要认人;调用方传的完整 Payment 行本就带它
  wxUserId?: string | null;
  paymentBills: Array<{ billId: string; bill?: ReceiptBill | null }>;
};

interface ReceiptBill {
  title?: string | null;
  period?: string | null;
  amount?: unknown;
  houseId?: string | null;
  dueDate?: Date | null;
  house?: { displayName?: string | null; community?: { name?: string | null } | null } | null;
}
interface ReceiptPayment {
  orderNo: string;
  channel: string;
  totalAmount: unknown;
  /** 券抵扣额。收据必须带上它，否则明细各行之和与实收金额对不上 */
  discountAmount?: unknown;
  paymentBills?: Array<{ bill?: ReceiptBill | null }>;
}

/**
 * 支付服务（业主端，跨租户经绑定校验 → raw client）。
 * 单账单单支付：每笔订单对应一张账单（Payment.billId），同时保留 PaymentBill 以兼容历史多账单读取。
 * 状态机：CREATED →（预下单网络不确定）PREPAY_UNKNOWN → SUCCESS/FAILED/CLOSED；回调与查单幂等入账。
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly collectionPolicy: CollectionPolicyService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly coupons: CouponsService,
  ) {}

  private resolveChannel(): 'WXPAY' | 'MOCK' {
    return process.env.PAY_MODE === 'wxpay' ? 'WXPAY' : 'MOCK';
  }

  /** 微信支付部署范围校验：预下单前拦截未开通在线支付的租户/小区。 */
  private assertWxPayScope(tenantId: string, communityIds: string[]): void {
    const allowedTenant = process.env.WX_PAY_ALLOWED_TENANT_ID;
    const allowedCommunity = process.env.WX_PAY_ALLOWED_COMMUNITY_ID;
    if (!allowedTenant || !allowedCommunity) {
      throw new Error('微信支付开通范围未配置：WX_PAY_ALLOWED_TENANT_ID / WX_PAY_ALLOWED_COMMUNITY_ID');
    }
    if (tenantId !== allowedTenant || communityIds.some((id) => id !== allowedCommunity)) {
      throw new BizException(ErrorCode.PAYMENT_SCOPE_FORBIDDEN);
    }
  }

  /**
   * 事务内消费优惠券，返回抵扣的「分」。
   *
   * 全部校验必须在同一事务内完成并把券置 USED：
   * - 券归属本人且未使用；
   * - 在有效期内、券本身仍启用；
   * - 券适用于该小区（communityId 为 null 表示全公司通用）；
   * - 满足满减门槛；
   * - 抵扣不超过账单金额（不产生负数应付，也不退差额）。
   * 置 USED 用条件 updateMany，count 必须为 1，从而杜绝并发下同一张券
   * 被两笔支付同时抵扣。
   */
  private async consumeCouponInTx(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; ownerId: string; userCouponId: string; billCents: number; communityId: string },
  ): Promise<number> {
    const uc = await tx.userCoupon.findFirst({
      where: { id: input.userCouponId, wxUserId: input.ownerId, tenantId: input.tenantId },
      include: { coupon: true },
    });
    if (!uc) throw new BizException(ErrorCode.NOT_FOUND, '优惠券不存在或不属于您');
    if (uc.status !== 'UNUSED') throw new BizException(ErrorCode.VALIDATION, '该优惠券已使用或已过期');

    const coupon = uc.coupon;
    if (!coupon || !coupon.enabled) throw new BizException(ErrorCode.VALIDATION, '该优惠券已停用');

    const now = new Date();
    if (coupon.validFrom > now) throw new BizException(ErrorCode.VALIDATION, '该优惠券尚未开始生效');
    if (coupon.validTo < now) throw new BizException(ErrorCode.VALIDATION, '该优惠券已过期');
    if (coupon.communityId && coupon.communityId !== input.communityId) {
      throw new BizException(ErrorCode.VALIDATION, '该优惠券不适用于本小区');
    }

    const face = coupon.faceValue ? toCents(coupon.faceValue.toString()) : 0;
    if (face <= 0) throw new BizException(ErrorCode.VALIDATION, '该优惠券无可抵扣金额');
    const threshold = coupon.threshold ? toCents(coupon.threshold.toString()) : 0;
    if (input.billCents < threshold) {
      throw new BizException(
        ErrorCode.VALIDATION,
        `该优惠券需满 ${(threshold / 100).toFixed(2)} 元可用，本单金额不足`,
      );
    }

    /*
     * 抵扣上限为账单金额，且**不允许把应付降到 0**。
     *
     * 微信不接受 0 元订单（provider 校验 totalCents > 0）。而那个错误是普通 Error
     * 不是 PaymentProviderError，isExplicitPrepayReject 判 false，于是订单被转成
     * PREPAY_UNKNOWN：账单保持预占、券已在本事务内置为 USED，而微信侧压根没有这笔
     * 订单——业主从此既付不了这张账单、券也回不来，只能人工介入。
     *
     * 在事务内抛错让一切回滚（券不消耗、账单不占用），并明确告诉业主换一张账单用，
     * 而不是给一个「点了就卡死」的入口。零元核销是另一条资金路径，需要单独设计
     * （生成收据、审计、对账口径），不适合在这里顺手加。
     */
    const discount = Math.min(face, input.billCents);
    if (discount >= input.billCents) {
      throw new BizException(
        ErrorCode.VALIDATION,
        `该券可抵 ${(face / 100).toFixed(2)} 元，已覆盖本单全部金额，暂不支持零元支付；请用于金额更高的账单`,
      );
    }

    const used = await tx.userCoupon.updateMany({
      where: { id: uc.id, status: 'UNUSED' },
      data: { status: 'USED', usedAt: now },
    });
    if (used.count !== 1) {
      throw new BizException(ErrorCode.VALIDATION, '该优惠券刚刚已被使用，请刷新后重试');
    }
    return discount;
  }

  /**
   * 订单未成交或已退款时，把当时抵扣的优惠券置回 UNUSED。
   * 用条件 updateMany 保证幂等（重复调用不会把已重新使用的券再改回来）。
   */
  private async releaseCouponFor(paymentId: string): Promise<void> {
    const p = await this.prisma.raw.payment.findUnique({
      where: { id: paymentId },
      select: { userCouponId: true },
    });
    if (!p?.userCouponId) return;
    await this.prisma.raw.userCoupon.updateMany({
      where: { id: p.userCouponId, status: 'USED' },
      data: { status: 'UNUSED', usedAt: null },
    });
  }

  private genOrderNo(): string {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    return `WY${ymd}${rand}`;
  }

  /** 显式微信业务拒绝（4xx）应立即释放账单；网络/超时/5xx 视为结果不确定，保留预占。 */
  private isExplicitPrepayReject(error: unknown): boolean {
    return (
      error instanceof PaymentProviderError && error.status >= 400 && error.status < 500
    );
  }

  private wxPaySnapshot(channel: 'WXPAY' | 'MOCK') {
    if (channel !== 'WXPAY') return { mchid: null, appid: null, merchantAccountId: null };
    return {
      mchid: process.env.WX_PAY_MCH_ID ?? null,
      appid: process.env.WX_PAY_APP_ID ?? process.env.WX_APPID ?? null,
      merchantAccountId: process.env.WX_PAY_MERCHANT_SERIAL ?? null,
    };
  }

  /**
   * 单账单下单：billId 必须属于本人 ACTIVE 绑定房屋、UNPAID、未被进行中订单占用；
   * 以 requestId 做幂等；订单写入 billId/communityId 与金额、商户范围快照，事务内写创建审计。
   */
  async createPayment(ownerId: string, billId: string, requestId: string, userCouponId?: string) {
    if (typeof billId !== 'string' || !billId) {
      throw new BizException(ErrorCode.VALIDATION, '请选择单张账单支付');
    }
    if (typeof requestId !== 'string' || !requestId) {
      throw new BizException(ErrorCode.VALIDATION, '缺少幂等请求标识');
    }

    const bill = await this.prisma.raw.bill.findUnique({ where: { id: billId } });
    if (!bill) throw new BizException(ErrorCode.NOT_FOUND, '账单不存在');

    // 归属校验（安全前置，先于任何幂等/建单动作）。
    const binding = await this.prisma.raw.houseBinding.findFirst({
      where: { wxUserId: ownerId, houseId: bill.houseId, status: 'ACTIVE' },
    });
    if (!binding) throw new BizException(ErrorCode.NO_BINDING);

    const totalCents = toCents(bill.amount.toString());
    const tenantId = bill.tenantId;
    const communityId = bill.communityId;
    const channel = this.resolveChannel();
    if (channel === 'WXPAY') this.assertWxPayScope(tenantId, [communityId]);
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: ownerId } });

    // 业主流程无租户上下文；进入本单租户上下文以启用幂等与审计。
    return runWithTenant(tenantId, async () => {
      // 幂等复核须早于状态/占用校验：同一 requestId 的重放应返回已存结果，
      // 而不是被自己首个订单产生的占用挡回。
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: ownerId,
        action: 'owner.payment.create',
        requestId,
        payload: { billId, userCouponId: userCouponId ?? null },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody;
      if (reservation.outcome === 'IN_PROGRESS') {
        throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '支付请求处理中，请稍候重试');
      }
      if (reservation.outcome === 'FAILED') {
        throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, reservation.errorMessage);
      }

      let payment: { id: string; orderNo: string; totalAmount: unknown };
      try {
        if (bill.status !== 'UNPAID') {
          throw new BizException(
            ErrorCode.BILL_NOT_PAYABLE,
            // 业主端会把 message 原样 toast，绝不能把英文枚举甩给业主
            `账单「${bill.title}」当前${cn(BILL_STATUS_CN, bill.status)}，无法缴费`,
          );
        }
        // 占用校验：仅进行中订单（CREATED / PREPAY_UNKNOWN）占用账单，历史失败订单不阻挡重试
        const occupied = await this.prisma.raw.paymentBill.findFirst({
          where: { billId, payment: { status: { in: [...ACTIVE_PAYMENT_STATUSES] } } },
        });
        if (occupied) {
          throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '存在进行中的支付，请先完成或等待其关闭');
        }
        payment = await this.prisma.raw.$transaction(async (tx) => {
          // 与账单预占同事务加锁复核分层收款策略，防止并发暂停被绕过。
          await this.collectionPolicy.assertOpenForUpdate(tx, tenantId, [communityId]);

          // 优惠券抵扣：必须在同一事务内把券置为 USED，
          // 否则同一张券可被并发用于两笔支付（券只发一次、却抵扣两次）。
          let discountCents = 0;
          if (userCouponId) {
            discountCents = await this.consumeCouponInTx(tx, {
              tenantId,
              ownerId,
              userCouponId,
              billCents: totalCents,
              communityId,
            });
          }
          const payableCents = totalCents - discountCents;

          const p = await tx.payment.create({
            data: {
              tenantId,
              communityId,
              wxUserId: ownerId,
              billId,
              orderNo: this.genOrderNo(),
              totalAmount: (payableCents / 100).toFixed(2),
              discountAmount: discountCents > 0 ? (discountCents / 100).toFixed(2) : null,
              userCouponId: userCouponId ?? null,
              channel,
              status: 'CREATED',
              ...this.wxPaySnapshot(channel),
            },
          });
          const reserved = await tx.bill.updateMany({
            where: { id: billId, status: 'UNPAID', paymentId: null },
            data: { paymentId: p.id },
          });
          if (reserved.count !== 1) {
            throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单已被其他支付占用');
          }
          // 保留 PaymentBill，兼容既有列表/收据的多账单读取路径。
          await tx.paymentBill.create({ data: { paymentId: p.id, billId } });
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'WX_USER',
              actorId: ownerId,
              action: 'CREATE',
              resourceType: 'Payment',
              resourceId: p.id,
              requestId,
              afterSummary: { orderNo: p.orderNo, billId, totalAmount: p.totalAmount, channel },
            },
            tx,
          );
          return p;
        });
      } catch (error) {
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : 'CREATE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // 预下单放在事务外，避免网络耗时占用数据库连接。
      try {
        /*
         * 必须用**实付**金额向微信下单，而不是账单原额。
         *
         * 原实现传的是 totalCents（账单原额），而 Payment.totalAmount 落库的是
         * 抵扣后金额（payableCents）。业主一用券就会：微信按原价扣款成功 → 回调带回
         * 原额 → handleWxPayNotification 里 `transaction.amount.total !== expectedCents`
         * 判定「支付回调金额不一致」抛错 → 微信重试仍然失败 → queryAndReconcile
         * 有同样校验也救不回来。最终业主付了原价、账单永远停在未缴、系统不知道钱在哪。
         *
         * 这里刻意从 payment.totalAmount 反算，而不是把 payableCents 带出事务：
         * 下单金额与回调校验金额从此取自**同一个字段**，结构上就不可能再对不上。
         */
        const payableCents = toCents(String(payment.totalAmount));
        const payParams = await this.provider.createOrder({
          orderNo: payment.orderNo,
          totalCents: payableCents,
          description: bill.title.slice(0, 100),
          payerOpenid: user?.openid ?? '',
          tenantId,
        });
        const response = { orderNo: payment.orderNo, totalAmount: payment.totalAmount, payParams };
        await this.idempotency.complete({
          tenantId,
          recordId: reservation.recordId,
          responseCode: 0,
          responseBody: response,
        });
        return response;
      } catch (error) {
        if (this.isExplicitPrepayReject(error)) {
          // 明确拒绝：立即失败并释放账单预占。
          await this.finishUnpaidPayment(payment.id, 'FAILED');
          await this.idempotency.fail({
            tenantId,
            recordId: reservation.recordId,
            errorCode: error instanceof PaymentProviderError ? error.code : 'PREPAY_REJECTED',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        // 结果不确定：转 PREPAY_UNKNOWN，账单保持预占，交由恢复任务查单裁决。
        await this.prisma.raw.payment.updateMany({
          where: { id: payment.id, status: 'CREATED' },
          data: { status: 'PREPAY_UNKNOWN' },
        });
        const response = { orderNo: payment.orderNo, totalAmount: payment.totalAmount, status: 'PREPAY_UNKNOWN' as const };
        await this.idempotency.complete({
          tenantId,
          recordId: reservation.recordId,
          responseCode: 0,
          responseBody: response,
        });
        return response;
      }
    });
  }

  /** 成功入账时生成的不可变、与付款人无关的收据快照。 */
  private buildReceipt(
    payment: ReceiptPayment,
    paidAt: Date,
    transactionId: string | null,
  ): { receiptNo: string; snapshot: Prisma.InputJsonObject } {
    const receiptNo = `RCPT-${payment.orderNo}`;
    const bills = (payment.paymentBills ?? []).map((pb) => ({
      title: pb.bill?.title ?? null,
      period: pb.bill?.period ?? null,
      amount: pb.bill?.amount != null ? String(pb.bill.amount) : null,
    }));
    const firstHouse = payment.paymentBills?.[0]?.bill?.house ?? null;
    const snapshot: Prisma.InputJsonObject = {
      receiptNo,
      orderNo: payment.orderNo,
      channel: payment.channel,
      transactionId: transactionId ?? null,
      totalAmount: String(payment.totalAmount),
      paidAt: paidAt.toISOString(),
      community: firstHouse?.community?.name ?? null,
      house: firstHouse?.displayName ?? null,
      bills,
      /*
       * 券抵扣额必须进快照。
       *
       * 没有它，收据上的明细是各张账单的原价（合计 1200），而「实收金额」是扣券后的
       * 1180 —— **这张收据自己对不上账**，凭空少 20 元。而收据页明确写着
       * 「可发送给他人或用于报销」，对不上账的凭证会被财务退回。
       *
       * 快照是不可变的，历史订单没有这个字段：前端按缺失处理（不显示抵扣行），
       * 不能因为字段不存在就把整张收据判为异常。
       */
      discountAmount:
        payment.discountAmount != null && Number(String(payment.discountAmount)) > 0
          ? String(payment.discountAmount)
          : null,
      issuedAt: new Date().toISOString(),
    };
    return { receiptNo, snapshot };
  }

  /**
   * 幂等成功入账 + 事务内生成不可变收据快照。
   * source 记录确认来源（回调/查单/mock），供审计与对账区分。
   */
  private async applyWxPaySuccess(
    payment: SettleablePayment,
    transaction: WxPayTransaction,
    source: 'WXPAY_NOTIFY' | 'WXPAY_QUERY',
  ): Promise<{ orderNo: string; status: 'SUCCESS' }> {
    if (payment.status === 'SUCCESS') {
      if (payment.transactionId !== transaction.transaction_id) throw new Error('支付回调交易号不一致');
      return { orderNo: payment.orderNo, status: 'SUCCESS' };
    }
    if (!ACTIVE_PAYMENT_STATUSES.includes(payment.status as (typeof ACTIVE_PAYMENT_STATUSES)[number])) {
      throw new Error(`支付回调订单状态不可入账：${payment.status}`);
    }

    /*
     * 从这里往下必须处于**订单所属租户的上下文**中。
     *
     * 2026-08-01 事故的真正根因就是缺了这一层。入账事务里要写一条 PAY 审计，
     * 而 audit.append 的第一句是 assertTenantAccess(tenantId) —— 没有租户上下文就抛
     * FORBIDDEN「缺少租户上下文」。微信回调没有登录态，定时兜底任务也没有，
     * 于是两条系统路径都在这里抛错、整个入账事务回滚：
     *   · 回调：业主的钱扣了，订单留在 CREATED、账单留在 UNPAID，页面停在「入账中」
     *   · 兜底：每轮扫描抛同一个错，这条保底路径从未真正救回过任何一笔
     * 生产实测（订单 WY20260801018839）：回调 14:55:50 到达并验签通过，
     * 微信重试 4 次全部失败，失败原因正是「无权限访问：缺少租户上下文」。
     *
     * 这不是新写法：reconciliation.service（对账 cron）与 refund.service（退款回调）
     * 早就是 runWithTenant(record.tenantId, ...) —— 只有支付入账这一条漏了。
     * 回调处理订单 X，本质上就是在 X 所属租户里操作，上下文从订单本身推出来即可。
     *
     * 拆成独立方法而不是把函数体裹进闭包：闭包里的 return 语义容易看错，
     * 而这段是资金落账的代码。
     */
    return runWithTenant(payment.tenantId, () => this.settleWxPayInTenant(payment, transaction, source));
  }

  /** applyWxPaySuccess 的落账主体；调用方已保证处于订单所属租户的上下文中。 */
  private async settleWxPayInTenant(
    payment: SettleablePayment,
    transaction: WxPayTransaction,
    source: 'WXPAY_NOTIFY' | 'WXPAY_QUERY',
  ): Promise<{ orderNo: string; status: 'SUCCESS' }> {
    const paidAt = transaction.success_time ? new Date(transaction.success_time) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new Error('支付回调成功时间无效');
    const { receiptNo, snapshot } = this.buildReceipt(payment, paidAt, transaction.transaction_id);

    /*
     * 条件更新一行都没匹配上时，**绝对不能当成「别人已经做过了」**。
     *
     * 2026-08-01 事故的真正根因就在这里。原代码是 `if (updated.count === 0) return;`，
     * 事务结束后函数照旧 `return { status: 'SUCCESS' }`。于是：
     *   微信回调 → 这里 count=0 → 静默 return → 控制器回 HTTP 200 {code:'SUCCESS'}
     *   → 微信认定投递成功、**永不重试**
     *   → 订单留在 CREATED、账单留在 UNPAID、业主的钱扣了
     *   → 没有告警、没有失败事件、审计里没有 PAY —— 全链路零痕迹
     * 生产实测：回调 12:37:45 到达并验签通过（wxpayNotifiedAt 有值、NOTIFIED 事件
     * 已落库），而入账直到 13:19:34 才由人工查单完成，中间 42 分钟无人知晓。
     *
     * count=0 只说明「有人并发把状态挪出了可入账区间」，不等于「有人把它入账了」——
     * 比如并发的那一方在后续步骤抛错回滚，状态又回到 CREATED，两边就都以为对方做了。
     * 所以必须事后核实真的到了 SUCCESS；没到就抛错，让微信重试、让告警响。
     */
    let skippedByConcurrentUpdate = false;
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: [...ACTIVE_PAYMENT_STATUSES] } },
        data: {
          status: 'SUCCESS',
          transactionId: transaction.transaction_id,
          paidAt,
          confirmedBy: source,
          confirmedAt: new Date(),
          receiptNo,
          receiptSnapshot: snapshot,
        },
      });
      if (updated.count === 0) {
        skippedByConcurrentUpdate = true;
        return;
      }

      const bills = await tx.bill.updateMany({
        where: {
          id: { in: payment.paymentBills.map((item) => item.billId) },
          status: 'UNPAID',
          paymentId: payment.id,
        },
        data: { status: 'PAID', paidAt },
      });
      if (bills.count !== payment.paymentBills.length) throw new Error('支付订单关联账单状态异常');

      /*
       * 入账本身也要留一条事件。
       *
       * 原来只有回调到达时写 NOTIFIED（recordNotifyEvidence），入账这一步不写。
       * 于是**纯靠查单入账的订单，溯源时间线是空的** —— 而 2026-08-01 之后
       * 恰恰每一笔都是这样（回调链路没通）。时间线空着，看的人无从判断
       * 「是没发生过，还是没记录」。
       * 生产实测：退款溯源上线后三笔退款的事件都是 0 条，暴露了同一个问题。
       *
       * eventKey 带 transactionId：同一笔支付只会入账一次，天然幂等；
       * 放在同一事务内 —— 钱记了而事件没记，就又制造了一次「看不出来」。
       */
      await tx.paymentEvent.create({
        data: {
          tenantId: payment.tenantId,
          communityId: payment.communityId,
          paymentId: payment.id,
          eventKey: `confirm:${payment.orderNo}:${transaction.transaction_id}`,
          type: 'CONFIRMED',
          status: 'PROCESSED',
          source,
          summary: {
            transactionId: transaction.transaction_id,
            amountTotal: transaction.amount.total,
            receiptNo,
          },
          occurredAt: paidAt,
          processedAt: new Date(),
        },
      });

      /*
       * 微信支付成功入账必须写审计。
       *
       * 这是整条资金链上最核心的一步——钱真正到账、账单销账。而生产审计日志 73 条里
       * 有「业主下单」Payment/CREATE、「线下收款」Payment/PAY、「退款」Refund/REFUND
       * （含 SYSTEM 类型），唯独没有这一步：查一笔钱的来龙去脉时，审计链会从 CREATE
       * 直接跳到 REFUND，中间「什么时候确认收到钱」是空的。
       *
       * 「系统动作也写审计」本就是这个系统的既有约定（退款终态、发票冲红都用
       * actorType: 'SYSTEM'），所以这里不是设计选择，是遗漏。
       *
       * 放在同一事务内：审计与入账要么都成，要么都不成，不能出现「钱记了、审计没记」。
       * source 一并记下（WXPAY_NOTIFY 是回调、WXPAY_QUERY 是主动查单），
       * 排查时能区分「微信推过来的」还是「我们查出来的」。
       */
      await this.audit.append(
        {
          tenantId: payment.tenantId,
          communityId: payment.communityId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'PAY',
          resourceType: 'Payment',
          resourceId: payment.id,
          afterSummary: {
            orderNo: payment.orderNo,
            transactionId: transaction.transaction_id,
            totalAmount: String(payment.totalAmount),
            paidAt: paidAt.toISOString(),
            source,
            billIds: payment.paymentBills.map((item) => item.billId),
          },
        },
        tx,
      );
    });

    /*
     * 入账成功后按规则自动发券(满 X 元/按时缴/无欠费)。
     * 放在事务之外、并发跳过判定之前的这个位置不行 —— 必须确认真的入账了才发,
     * 所以见下:两处 return SUCCESS 前各调一次不行(重复),统一放在最后的成功出口。
     */
    if (skippedByConcurrentUpdate) {
      /*
       * 在事务之外重读：MySQL 默认 REPEATABLE READ，同一事务内的 SELECT 可能仍看
       * 旧快照，读出来的结论不可信。
       */
      const fresh = await this.prisma.raw.payment.findUnique({
        where: { id: payment.id },
        select: { status: true, transactionId: true },
      });
      if (fresh?.status === 'SUCCESS' && fresh.transactionId === transaction.transaction_id) {
        // 并发的那一方确实入账成功了，这次是真正的幂等重复，返回成功
        return { orderNo: payment.orderNo, status: 'SUCCESS' };
      }
      /*
       * 抛错而不是返回成功：调用方是微信回调时，非 2xx 会让微信按退避重试，
       * 这是钱能自己回来的关键；同时控制器会写 CRITICAL 告警。
       */
      throw new Error(
        `支付入账被并发跳过且未真正成功：order=${payment.orderNo} 当前状态=${fresh?.status ?? '不存在'}`,
      );
    }

    await this.coupons.autoGrantOnPayment({
      tenantId: payment.tenantId,
      communityId: payment.communityId ?? null,
      wxUserId: payment.wxUserId ?? null,
      paidAmount: Number(payment.totalAmount),
      paidAt,
      bills: payment.paymentBills
        .filter((item) => item.bill && item.bill.houseId)
        .map((item) => ({ houseId: item.bill!.houseId as string, dueDate: item.bill!.dueDate ?? null })),
    });
    return { orderNo: payment.orderNo, status: 'SUCCESS' };
  }

  private receiptInclude() {
    return {
      paymentBills: {
        include: { bill: { include: { house: { include: { community: { select: { name: true } } } } } } },
      },
    };
  }

  /**
   * 记录一次「回调到了但处理失败」。
   *
   * 为什么必须落库而不是只发告警：告警走 emitCallbackRejectedAlert，
   * 而它在 WX_PAY_ALLOWED_TENANT_ID 缺失时会静默 return —— 一个依赖环境变量
   * 才存在的痕迹，不能当作唯一痕迹。而且告警是按小时去重的全局对象，
   * 定位不到**具体哪一笔**。
   *
   * 落成 PaymentEvent 之后，「入账溯源」的时间线上直接能看到
   * 「收到微信回调 / 处理失败 / 原因」，排查从一小时缩到一眼。
   * 这次事故我恰恰是因为没有这条记录，先误判成「回调没来过」。
   *
   * 按 (orderNo, transactionId) 收敛到一行并累加 attempts：微信会重试多次，
   * 每次新建一行会把时间线冲满，而「重试了几次仍然失败」本身是有用信息。
   */
  async recordNotifyFailure(orderNo: string, transactionId: string | null, message: string): Promise<void> {
    try {
      const payment = await this.prisma.raw.payment.findUnique({
        where: { orderNo },
        select: { id: true, tenantId: true, communityId: true },
      });
      if (!payment) return;
      const eventKey = `notify-fail:${orderNo}:${transactionId ?? 'unknown'}`;
      /*
       * upsert 而不是「先查再更新」：微信的重试可能并发到达，读后写会让两次重试
       * 都以为自己是第一次、双双 create 后一方撞唯一键失败 —— 那次失败的痕迹就丢了。
       * 交给数据库的 @@unique([tenantId, eventKey]) 收口，attempts 用原子 increment。
       */
      await this.prisma.raw.paymentEvent.upsert({
        where: { tenantId_eventKey: { tenantId: payment.tenantId, eventKey } },
        create: {
          tenantId: payment.tenantId,
          communityId: payment.communityId,
          paymentId: payment.id,
          eventKey,
          type: 'NOTIFIED',
          status: 'FAILED',
          source: 'WXPAY_NOTIFY',
          attempts: 1,
          lastError: message.slice(0, 480),
        },
        update: {
          attempts: { increment: 1 },
          lastError: message.slice(0, 480),
          status: 'FAILED',
        },
      });
    } catch (error) {
      /*
       * 写痕迹本身失败不能影响回调应答：应答必须是非 2xx，微信才会重试。
       * 但要留一行日志，否则「痕迹机制自己坏了」又成了一个看不见的故障。
       */
      this.logger.error(
        `回调失败痕迹写入失败（该笔故障将只剩告警可查）order=${orderNo}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 主动查单成功入账（查单来源）：供 sync/cancel/reconcile 复用。 */
  async handleWxPaySuccess(transaction: WxPayTransaction) {
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo: transaction.out_trade_no },
      include: this.receiptInclude(),
    });
    if (!payment) throw new Error('支付回调订单不存在');
    if (payment.channel !== 'WXPAY') throw new Error('支付回调订单渠道不匹配');

    const expectedCents = toCents(payment.totalAmount.toString());
    if (transaction.amount.total !== expectedCents) throw new Error('支付回调金额不一致');

    return this.applyWxPaySuccess(payment, transaction, 'WXPAY_QUERY');
  }

  /**
   * 微信支付回调：验签解密已由 Provider 完成。
   * 先持久化回调证据（PaymentEvent + wxpayNotifiedAt，即使已通过查单成功也记录），再幂等成功入账。
   */
  async handleWxPayNotification(transaction: WxPayTransaction) {
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo: transaction.out_trade_no },
      include: this.receiptInclude(),
    });
    if (!payment) throw new Error('支付回调订单不存在');
    if (payment.channel !== 'WXPAY') throw new Error('支付回调订单渠道不匹配');

    const expectedCents = toCents(payment.totalAmount.toString());
    if (transaction.amount.total !== expectedCents) throw new Error('支付回调金额不一致');

    await this.recordNotifyEvidence(payment, transaction);
    return this.applyWxPaySuccess(payment, transaction, 'WXPAY_NOTIFY');
  }

  /** 记录回调证据：PaymentEvent(NOTIFIED) 幂等 + 首次置 wxpayNotifiedAt。证据不含付款人身份。 */
  private async recordNotifyEvidence(
    payment: { id: string; tenantId: string; communityId: string | null; orderNo: string },
    transaction: WxPayTransaction,
  ): Promise<void> {
    const eventKey = `notify:${payment.orderNo}:${transaction.transaction_id}`;
    await this.prisma.raw.$transaction(async (tx) => {
      const existing = await tx.paymentEvent.findFirst({
        where: { tenantId: payment.tenantId, eventKey },
      });
      if (!existing) {
        await tx.paymentEvent.create({
          data: {
            tenantId: payment.tenantId,
            communityId: payment.communityId,
            paymentId: payment.id,
            eventKey,
            type: 'NOTIFIED',
            status: 'PROCESSED',
            source: 'WXPAY_NOTIFY',
            summary: {
              transactionId: transaction.transaction_id,
              tradeState: transaction.trade_state,
              amountTotal: transaction.amount.total,
              successTime: transaction.success_time ?? null,
            },
            occurredAt: transaction.success_time ? new Date(transaction.success_time) : new Date(),
            processedAt: new Date(),
          },
        });
      }
      await tx.payment.updateMany({
        where: { id: payment.id, wxpayNotifiedAt: null },
        data: { wxpayNotifiedAt: new Date() },
      });
    });
  }

  /** mock 确认支付：事务内翻转订单与账单状态；重复调用幂等 */
  async mockConfirm(ownerId: string, orderNo: string) {
    const mockAllowed = process.env.PAY_MODE === 'mock'
      && process.env.ALLOW_MOCK_PAYMENTS === 'true';
    if (!mockAllowed) {
      throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '当前环境不可 mock 确认');
    }
    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo },
      include: this.receiptInclude(),
    });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (payment.channel !== 'MOCK') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '真实支付订单不可 mock 确认');
    if (payment.status === 'SUCCESS') return { orderNo, status: 'SUCCESS' }; // 幂等
    if (payment.status !== 'CREATED') {
      throw new BizException(
        ErrorCode.PAYMENT_STATE_INVALID,
        `该笔缴费当前${cn(PAYMENT_STATUS_CN, payment.status)}，无法继续`,
      );
    }

    const paidAt = new Date();
    const transactionId = `MOCK-${orderNo}`;
    const { receiptNo, snapshot } = this.buildReceipt(payment, paidAt, transactionId);
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, status: 'CREATED' },
        data: {
          status: 'SUCCESS',
          paidAt,
          transactionId,
          confirmedBy: 'MOCK',
          confirmedAt: new Date(),
          receiptNo,
          receiptSnapshot: snapshot,
        },
      });
      if (updated.count === 0) return; // 并发下已被处理
      const bills = await tx.bill.updateMany({
        where: {
          id: { in: payment.paymentBills.map((pb) => pb.billId) },
          status: 'UNPAID',
          paymentId: payment.id,
        },
        data: { status: 'PAID', paidAt },
      });
      if (bills.count !== payment.paymentBills.length) throw new Error('Mock 支付关联账单状态异常');
    });
    return { orderNo, status: 'SUCCESS', paidAt };
  }

  private async finishUnpaidPayment(paymentId: string, status: 'CLOSED' | 'FAILED'): Promise<void> {
    /*
     * 订单未成交（关闭/失败）时把抵扣券退还业主，否则券被白扣。
     *
     * 关键：退券必须在「订单确实被改成未成交」**之后**、且在同一事务内。
     *
     * 原实现在事务外、状态判定之前就无条件 releaseCouponFor()。而
     * releaseCouponFor 的唯一条件是券 status='USED'，不看支付是否已成交。
     * 于是存在这条竞态：恢复任务查单得到 NOTPAY → 业主随后在收银台付款成功 →
     * 回调把 Payment 置 SUCCESS、账单 PAID → 恢复任务继续走 close() →
     * **先把券退了** → 事务里 updateMany 命中 0 行直接 return，退券不会回滚。
     * 结果：账单按抵扣后金额销账（物业承担了券的成本），券却回到 UNUSED 可再用一次，
     * 每次命中泄漏一张券的面额；而 Payment.userCouponId 仍指向它，对账也看不出异常。
     */
    await this.prisma.raw.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: [...ACTIVE_PAYMENT_STATUSES] } },
        data: { status },
      });
      if (updated.count === 0) return;
      await tx.bill.updateMany({
        where: { paymentId, status: 'UNPAID' },
        data: { paymentId: null },
      });
      const p = await tx.payment.findUnique({ where: { id: paymentId }, select: { userCouponId: true } });
      if (p?.userCouponId) {
        await tx.userCoupon.updateMany({
          where: { id: p.userCouponId, status: 'USED' },
          data: { status: 'UNUSED', usedAt: null },
        });
      }
    });
  }

  /** 用户取消收银台后先查单，确认未支付才关单并释放账单。 */
  async cancelWxPay(ownerId: string, orderNo: string) {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (payment.status === 'SUCCESS') return { orderNo, status: 'SUCCESS' as const };
    if (payment.channel !== 'WXPAY' || payment.status !== 'CREATED') {
      return { orderNo, status: payment.status };
    }
    if (!this.provider.queryOrder) throw new Error('当前支付渠道不支持主动查单');

    const transaction = await this.provider.queryOrder(orderNo);
    if (transaction.trade_state === 'SUCCESS') return this.handleWxPaySuccess(transaction);
    if (transaction.trade_state === 'REFUND') throw new Error('退款状态需通过退款单核对');
    if (transaction.trade_state !== 'CLOSED') await this.provider.close(orderNo);
    await this.finishUnpaidPayment(payment.id, 'CLOSED');
    return { orderNo, status: 'CLOSED' as const };
  }

  /** 定时任务处理超过支付窗口的 CREATED / PREPAY_UNKNOWN 订单，避免账单被永久占用。 */
  /**
   * 向微信查单并按结果裁决。
   *
   * allowClose 把「查」和「关」分开：
   *   · 查单是只读的，越早做越好 —— 业主付了钱就该尽快入账
   *   · 关单会终结订单并释放账单，如果业主还在收银台输密码，关掉就是把他的支付作废
   *
   * 原实现两件事共用一个 30 分钟门槛，于是「早点让钱到账」被「别误关单」拖住了 ——
   * 真实事故里业主付款后干等了半小时，就是这个耦合造成的。
   */
  async reconcileStaleWxPay(
    orderNo: string,
    options: { allowClose?: boolean; expectTenantId?: string } = {},
  ) {
    /*
     * allowClose = 是否允许写入「未支付终态」（关单 / 判失败）。
     * 这两种写入都会终结订单并释放账单，对还在收银台输密码的业主是破坏性的，
     * 所以由调用方按订单年龄决定；查单本身（只读）不受它约束。
     */
    const allowClose = options.allowClose !== false;
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    /*
     * 跨租户防护。这里按 orderNo 用 prisma.raw 查（回调与定时任务都没有租户上下文，
     * 只能用 raw），所以必须由调用方显式声明「我期望它属于哪个租户」。
     *
     * 原先这条防护是**顺带**成立的：入账时 audit.append 会 assertTenantAccess，
     * 管理员租户与订单租户不一致就抛「租户上下文不匹配」。而修复入账问题时
     * settleWxPayInTenant 已按订单租户建立上下文，那道副作用防护随之消失 ——
     * 所以要在这里补成显式的。订单号形如 WY+日期+6 位随机数，并非不可猜。
     */
    if (payment && options.expectTenantId && payment.tenantId !== options.expectTenantId) {
      throw new BizException(ErrorCode.NOT_FOUND);
    }
    if (
      !payment ||
      payment.channel !== 'WXPAY' ||
      !ACTIVE_PAYMENT_STATUSES.includes(payment.status as (typeof ACTIVE_PAYMENT_STATUSES)[number])
    ) {
      return payment ? { orderNo, status: payment.status } : null;
    }
    if (!this.provider.queryOrder) throw new Error('当前支付渠道不支持主动查单');

    let transaction: WxPayTransaction;
    try {
      transaction = await this.provider.queryOrder(orderNo);
    } catch (error) {
      if (error instanceof PaymentProviderError && error.code === 'ORDER_NOT_EXIST') {
        /*
         * 微信侧查无此单 → 业主不可能付过款，判失败是对的。
         * 但仍受 allowClose 约束：刚下单的订单在微信侧短时间内可能还查不到，
         * 而 FAILED 是终态、会释放账单。查单窗口从 30 分钟缩到 2 分钟之后，
         * 这个分支不加约束就成了新的误判来源。
         */
        if (!allowClose) return { orderNo, status: payment.status };
        await this.finishUnpaidPayment(payment.id, 'FAILED');
        return { orderNo, status: 'FAILED' as const };
      }
      throw error;
    }
    if (transaction.trade_state === 'SUCCESS') return this.handleWxPaySuccess(transaction);
    if (transaction.trade_state === 'REFUND') throw new Error('退款状态需通过退款单核对');
    if (transaction.trade_state === 'NOTPAY') {
      /*
       * 未支付时不要急着关单：业主可能正在收银台输密码。
       * 只有等得足够久（调用方按订单年龄决定）才关，否则原样返回、下一轮再看。
       */
      if (!allowClose) return { orderNo, status: payment.status };
      await this.provider.close(orderNo);
      await this.finishUnpaidPayment(payment.id, 'CLOSED');
      return { orderNo, status: 'CLOSED' as const };
    }
    if (transaction.trade_state === 'CLOSED') {
      await this.finishUnpaidPayment(payment.id, 'CLOSED');
      return { orderNo, status: 'CLOSED' as const };
    }
    if (['REVOKED', 'PAYERROR'].includes(transaction.trade_state)) {
      await this.finishUnpaidPayment(payment.id, 'FAILED');
      return { orderNo, status: 'FAILED' as const };
    }
    return { orderNo, status: payment.status };
  }

  /**
   * 管理端解决账单占用的订单（供账单作废前调用）：
   * SUCCESS 直接返回；WXPAY 进行中 → 查单裁决；MOCK/OFFLINE 进行中 → 关单释放账单。
   */
  async resolveActiveOrder(orderNo: string): Promise<{ orderNo: string; status: string } | null> {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (!payment) return null;
    if (!ACTIVE_PAYMENT_STATUSES.includes(payment.status as (typeof ACTIVE_PAYMENT_STATUSES)[number])) {
      return { orderNo, status: payment.status };
    }
    if (payment.channel === 'WXPAY') {
      const result = await this.reconcileStaleWxPay(orderNo);
      return result ?? { orderNo, status: payment.status };
    }
    await this.finishUnpaidPayment(payment.id, 'CLOSED');
    return { orderNo, status: 'CLOSED' };
  }

  /** 前端支付后主动查单，回调延迟或丢失时复用同一入账逻辑。 */
  async syncWxPay(ownerId: string, orderNo: string) {
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo } });
    if (!payment || payment.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    if (payment.status === 'SUCCESS') return { orderNo, status: 'SUCCESS' as const };
    if (payment.channel !== 'WXPAY') return { orderNo, status: payment.status };
    if (!this.provider.queryOrder) throw new Error('当前支付渠道不支持主动查单');

    const transaction = await this.provider.queryOrder(orderNo);
    if (transaction.out_trade_no !== orderNo) throw new Error('微信支付查单订单号不匹配');
    if (transaction.trade_state === 'SUCCESS') {
      if (!transaction.transaction_id) throw new Error('微信支付查单缺少交易号');
      return this.handleWxPaySuccess(transaction);
    }

    if (transaction.trade_state === 'CLOSED') {
      await this.finishUnpaidPayment(payment.id, 'CLOSED');
      return { orderNo, status: 'CLOSED' as const };
    }
    if (transaction.trade_state === 'REFUND') throw new Error('退款状态需通过退款单核对');
    if (['REVOKED', 'PAYERROR'].includes(transaction.trade_state)) {
      await this.finishUnpaidPayment(payment.id, 'FAILED');
      return { orderNo, status: 'FAILED' as const };
    }
    return { orderNo, status: payment.status };
  }

  /**
   * 确认页向后端复核：返回该账单的权威金额与分层收款状态，
   * 前端据此展示，不再信任本地缓存的选中汇总。
   */
  async quoteBill(ownerId: string, billId: string) {
    if (typeof billId !== 'string' || !billId) throw new BizException(ErrorCode.VALIDATION, '缺少账单');
    const bill = await this.prisma.raw.bill.findUnique({
      where: { id: billId },
      include: { house: { include: { community: { select: { name: true } } } } },
    });
    if (!bill) throw new BizException(ErrorCode.NOT_FOUND);
    // 草稿账单对业主不可见：列表/详情/汇总/筛选均已过滤，此处若漏判，
    // 业主凭 billId 就能看到未发布账单的标题与金额。
    if (bill.status === 'DRAFT') throw new BizException(ErrorCode.NOT_FOUND);
    const binding = await this.prisma.raw.houseBinding.findFirst({
      where: { wxUserId: ownerId, houseId: bill.houseId, status: 'ACTIVE' },
    });
    if (!binding) throw new BizException(ErrorCode.NO_BINDING);
    const collection = await this.collectionPolicy.resolveEffectiveStatus(bill.tenantId, bill.communityId);
    // 占用校验：被进行中订单（CREATED/PREPAY_UNKNOWN）占用的账单，虽仍 UNPAID 但此刻不可再发起支付，
    // 否则确认页显示"可付"、点击却被 createPayment 以"存在进行中的支付"拒绝。
    const occupied = await this.prisma.raw.paymentBill.findFirst({
      where: { billId: bill.id, payment: { status: { in: [...ACTIVE_PAYMENT_STATUSES] } } },
      select: { billId: true },
    });
    /*
     * 该账单可用的优惠券：满足门槛、在有效期、适用本小区、未使用，
     * 且**抵扣后实付必须为正**。
     *
     * 最后这条是单一真源：consumeCouponInTx 会拒绝把应付降到 0（微信不接受 0 元
     * 订单，且那个错误会让订单卡进 PREPAY_UNKNOWN、账单被占用、券被消耗）。若这里
     * 仍把这类券返回给小程序，确认页会显示「确认支付 ¥0.00」并让业主点下去，点了
     * 才被后端拒绝——业主看到的可选项必须与后端实际接受的一致。
     */
    const billCents = toCents(bill.amount.toString());
    const now = new Date();
    /*
     * 必须带 tenantId：consumeCouponInTx 强制 tenantId 匹配（见其 where 子句），
     * 这里若不带，业主在 A 物业领的券会出现在 B 物业账单的可用券列表里，
     * 点下去被「优惠券不存在或不属于你」拒掉——与刚修的「显示 ¥0.00 再被拒」同一类
     * 「前端给的选项后端不接受」。
     * 另加稳定排序：券多于 50 张时 take 会截断，按面额降序保证不会把最优券切掉。
     */
    const myCoupons = await this.prisma.raw.userCoupon.findMany({
      where: { wxUserId: ownerId, status: 'UNUSED', tenantId: bill.tenantId },
      include: { coupon: true },
      orderBy: { coupon: { faceValue: 'desc' } },
      take: 50,
    });
    const usableCoupons = myCoupons
      .filter((uc) => {
        const c = uc.coupon;
        if (!c || !c.enabled) return false;
        if (c.validFrom > now || c.validTo < now) return false;
        if (c.communityId && c.communityId !== bill.communityId) return false;
        const face = c.faceValue ? toCents(c.faceValue.toString()) : 0;
        if (face <= 0) return false;
        const threshold = c.threshold ? toCents(c.threshold.toString()) : 0;
        if (billCents < threshold) return false;
        // 抵扣上限为账单金额；等于账单金额意味着实付 0 元，后端会拒，这里就不该给
        return Math.min(face, billCents) < billCents;
      })
      .map((uc) => {
        const c = uc.coupon;
        const face = toCents(c.faceValue!.toString());
        const discount = Math.min(face, billCents);
        return {
          userCouponId: uc.id,
          name: c.name,
          discount: (discount / 100).toFixed(2),
          threshold: c.threshold ? c.threshold.toString() : null,
          validTo: c.validTo,
        };
      })
      .sort((a, b) => Number(b.discount) - Number(a.discount));

    return {
      billId: bill.id,
      title: bill.title,
      amount: bill.amount,
      status: bill.status,
      period: bill.period,
      house: { displayName: bill.house.displayName, communityName: bill.house.community.name },
      collection,
      usableCoupons,
      pendingOrder: !!occupied,
      payable: bill.status === 'UNPAID' && collection.status === 'OPEN' && !occupied,
    };
  }

  async listPayments(ownerId: string, page: number, pageSize: number) {
    const where = { wxUserId: ownerId };
    const [list, total] = await Promise.all([
      this.prisma.raw.payment.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { paymentBills: { include: { bill: { select: { title: true, amount: true, period: true } } } } },
      }),
      this.prisma.raw.payment.count({ where }),
    ]);
    return {
      list: list.map((p) => ({
        orderNo: p.orderNo,
        totalAmount: p.totalAmount,
        status: p.status,
        channel: p.channel,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
        bills: p.paymentBills.map((pb) => pb.bill),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getPayment(ownerId: string, orderNo: string) {
    const p = await this.prisma.raw.payment.findUnique({
      where: { orderNo },
      include: {
        paymentBills: {
          include: {
            bill: { include: { house: { include: { community: { select: { name: true } } } } } },
          },
        },
      },
    });
    if (!p || p.wxUserId !== ownerId) throw new BizException(ErrorCode.NOT_FOUND);
    // 收据房屋以「订单本身对应的房屋」为准（取首张账单的房屋），而非当前选中房屋
    const firstHouse = p.paymentBills[0]?.bill?.house ?? null;
    // 收据：优先不可变快照；发布前已支付的历史订单无快照 → 按订单当前数据回退生成，保证老收据不消失
    let receiptNo = p.receiptNo ?? null;
    let receipt: unknown = p.receiptSnapshot ?? null;
    if (!receipt && (p.status === 'SUCCESS' || p.status === 'REFUNDED')) {
      const fb = this.buildReceipt(p, p.paidAt ?? p.createdAt, null);
      receiptNo = fb.receiptNo;
      receipt = fb.snapshot;
    }
    return {
      orderNo: p.orderNo,
      totalAmount: p.totalAmount,
      status: p.status,
      channel: p.channel,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      house: firstHouse
        ? { displayName: firstHouse.displayName, communityName: firstHouse.community.name }
        : null,
      bills: p.paymentBills.map((pb) => {
        const { house: _h, ...bill } = pb.bill as Record<string, unknown>;
        return bill;
      }),
      // 收据：不可变快照优先，历史订单回退生成；退款订单标记作废
      receiptNo,
      receipt,
      receiptVoid: p.status === 'REFUNDED',
    };
  }
}
