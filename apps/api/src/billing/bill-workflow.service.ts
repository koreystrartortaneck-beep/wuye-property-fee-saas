import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { OutboxService } from '../notify/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

/** 关闭账单占用的进行中订单（由支付服务实现），避免账单与作废竞态。 */
export const BILL_ORDER_CLOSER = Symbol('BILL_ORDER_CLOSER');
export interface BillOrderCloser {
  resolveActiveOrder(orderNo: string): Promise<{ orderNo: string; status: string } | null>;
}

interface PublishBatchInput {
  batchId: string;
  adminId: string;
  actingTenantId: string | null;
  requestId: string;
  reason?: string | null;
}

interface CancelBillInput {
  billId: string;
  adminId: string;
  actingTenantId: string | null;
  reason: string;
  requestId: string;
}

interface ReissueBillInput extends CancelBillInput {}

/** 账单发布 / 作废 / 重开：全部落幂等事务，事务内写审计与 Outbox。 */
@Injectable()
export class BillWorkflowService {
  private readonly logger = new Logger('BillWorkflow');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    @Optional() @Inject(BILL_ORDER_CLOSER) private readonly orderCloser: BillOrderCloser | null = null,
  ) {}

  private assertTenant(actingTenantId: string | null, ownerTenantId: string): void {
    if (actingTenantId !== null && actingTenantId !== ownerTenantId) {
      throw new BizException(ErrorCode.FORBIDDEN, '无权操作该租户的账单');
    }
  }

  private assertReason(reason: string): void {
    if (!reason || !reason.trim()) {
      throw new BizException(ErrorCode.VALIDATION, '必须填写操作原因');
    }
  }

  /** 发布草稿批次：原子将批次内 DRAFT 账单转 UNPAID 并冻结业务字段；幂等。 */
  async publishBatch(input: PublishBatchInput): Promise<{ batchId: string; status: string; publishedCount: number }> {
    const batch = await this.prisma.raw.billBatch.findUnique({ where: { id: input.batchId } });
    if (!batch) throw new BizException(ErrorCode.NOT_FOUND, '批次不存在');
    this.assertTenant(input.actingTenantId, batch.tenantId);
    if (batch.status === 'PUBLISHED') {
      const publishedCount = await this.prisma.raw.bill.count({ where: { batchId: batch.id, status: { not: 'DRAFT' } } });
      return { batchId: batch.id, status: 'PUBLISHED', publishedCount };
    }
    if (batch.status === 'CANCELED') {
      throw new BizException(ErrorCode.BILL_NOT_PAYABLE, '批次已作废，不可发布');
    }

    const tenantId = batch.tenantId;
    const communityId = batch.communityId;
    return runWithTenant(tenantId, async () => {
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: input.adminId,
        action: 'admin.bill.publish',
        requestId: input.requestId,
        payload: { batchId: input.batchId },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody as { batchId: string; status: string; publishedCount: number };
      if (reservation.outcome === 'IN_PROGRESS') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '发布处理中，请稍候');
      if (reservation.outcome === 'FAILED') throw new BizException(ErrorCode.VALIDATION, reservation.errorMessage);

      try {
        const now = new Date();
        const { publishedCount } = await this.prisma.raw.$transaction(async (tx) => {
          const b = await tx.billBatch.updateMany({
            where: { id: input.batchId, tenantId, status: { in: ['DRAFT', 'GENERATING', 'READY'] } },
            data: { status: 'PUBLISHED', publishedAt: now, publishedBy: input.adminId },
          });
          if (b.count !== 1) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '批次状态已变更');
          /*
           * 只取投递与通知真正要用的列。原来取整行（含 snapshot 这个 Json 列），
           * 3000 户批次一次拉进内存约数 MB，且全部要过 Decimal 反序列化。
           */
          const drafts = await tx.bill.findMany({
            where: { batchId: input.batchId, status: 'DRAFT' },
            select: {
              id: true, tenantId: true, communityId: true, houseId: true,
              period: true, title: true, amount: true, dueDate: true,
            },
          });
          const upd = await tx.bill.updateMany({
            where: { batchId: input.batchId, status: 'DRAFT' },
            data: { status: 'UNPAID', publishedAt: now, publishedBy: input.adminId },
          });
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'ADMIN',
              actorId: input.adminId,
              action: 'PUBLISH',
              resourceType: 'BillBatch',
              resourceId: input.batchId,
              reason: input.reason ?? null,
              requestId: input.requestId,
              afterSummary: { status: 'PUBLISHED', publishedCount: upd.count },
            },
            tx,
          );
          /*
           * 一次 createMany 取代逐条 enqueue。
           *
           * outbox.enqueue 在事务内每次是 2 次数据库往返（取库时间 + insert），
           * 于是发布 N 户是 2N+3 次往返：
           *     4 户 → 11 次 ≈ 33ms（当前规模，无感）
           *   500 户 → 1003 次 ≈ 3.0s（濒临超时）
           *  3000 户 → 6003 次 ≈ 18s → **必然 P2028 事务超时、全量回滚**
           * 而这个 $transaction 没有传 timeout，走 Prisma 默认 5000ms
           * （同一份 outbox.service.ts 里三处事务都显式设了 30s，说明这里是漏了）。
           *
           * 更要命的是失败不可恢复：超时后 catch 调 idempotency.fail，而 FAILED 是
           * 终态（idempotency.service.ts 注释明写 "FAILED is terminal"），后续同键
           * 请求只会重放这个失败；而管理端 BillRun.vue 的 publishRequestId 被缓存
           * 复用、只在切账期时清空。于是「确认发布」这个不可绕过的动作会**永久失败**，
           * 3000 户小区的账单再也发不出去、业主看不到、收不了钱。
           *
           * availableAt 在事务外取一次系统时间即可：它只用于投递退避排序，不参与
           * 业务判定，不需要每条都问一次数据库时间。
           */
          await tx.outboxEvent.createMany({
            data: drafts.map((bill) => ({
              tenantId,
              communityId,
              aggregateType: 'Bill',
              aggregateId: bill.id,
              eventType: 'bill.published',
              dedupKey: `bill.published:${bill.id}`,
              payload: {
                billId: bill.id,
                houseId: bill.houseId,
                period: bill.period,
                amount: String(bill.amount),
              },
              status: 'PENDING',
              attempts: 0,
              availableAt: now,
            })),
            // 承接 enqueue 原有的 P2002 幂等语义：同 dedupKey 已存在则跳过
            skipDuplicates: true,
          });
          return { publishedCount: upd.count };
        }, {
          // 与 outbox.service.ts 的三处事务对齐。默认 5s 在几百户时就会超时，
          // 而这里超时等于永久发不出账单（见上）。
          maxWait: 5_000,
          timeout: 30_000,
        });

        /*
         * 通知一律由 Outbox 投递，这里不再逐条 onBillCreated。
         *
         * bill.published 事件在 notify.service 里映射到 BILL_CREATED 模板，与这个
         * 循环发的是同一条消息。两条路径并存时都会真发（onBillCreated 曾传
         * dedup=false），而「一次性订阅」一次授权只能发一条，后到的那条必得 43101
         * ——生产 NotifyLog 里 BILL_CREATED 零条 SENT、4 条 43101 FAILED 就是这么来的。
         *
         * 保留 Outbox 而不是保留这个循环，因为：它有退避重试、有租约、进程重启后
         * 事件仍在库里；而循环是 best-effort，warn 一行就没了。代价是通知延迟最多
         * 30 秒（dispatch cron 周期），对出账通知完全可接受。
         *
         * 另外这个循环本身在规模上也不可行：3000 户 = 3000 次串行微信调用，
         * 挂在「确认发布」这个 HTTP 请求里必然撞网关超时。
         */

        const response = { batchId: input.batchId, status: 'PUBLISHED', publishedCount };
        await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: response });
        return response;
      } catch (error) {
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : 'PUBLISH_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /** 作废账单：要求 paymentId IS NULL；存在进行中订单先查关，成功回调则拒绝作废。 */
  async cancelBill(input: CancelBillInput): Promise<{ billId: string; status: string }> {
    this.assertReason(input.reason);
    let bill = await this.prisma.raw.bill.findUnique({ where: { id: input.billId } });
    if (!bill) throw new BizException(ErrorCode.NOT_FOUND, '账单不存在');
    this.assertTenant(input.actingTenantId, bill.tenantId);
    if (!['DRAFT', 'UNPAID'].includes(bill.status)) {
      throw new BizException(ErrorCode.BILL_NOT_PAYABLE, '仅草稿或未缴账单可作废');
    }

    if (bill.paymentId) {
      if (!this.orderCloser) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单存在支付占用，暂不可作废');
      const payment = await this.prisma.raw.payment.findUnique({ where: { id: bill.paymentId } });
      if (payment) await this.orderCloser.resolveActiveOrder(payment.orderNo);
      const reloaded = await this.prisma.raw.bill.findUnique({ where: { id: input.billId } });
      if (!reloaded) throw new BizException(ErrorCode.NOT_FOUND, '账单不存在');
      if (reloaded.status === 'PAID') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单已支付，不可作废');
      if (reloaded.paymentId) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单仍被进行中的支付占用');
      bill = reloaded;
    }

    const tenantId = bill.tenantId;
    const communityId = bill.communityId;
    return runWithTenant(tenantId, async () => {
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: input.adminId,
        action: 'admin.bill.cancel',
        requestId: input.requestId,
        payload: { billId: input.billId },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody as { billId: string; status: string };
      if (reservation.outcome === 'IN_PROGRESS') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '作废处理中，请稍候');
      if (reservation.outcome === 'FAILED') throw new BizException(ErrorCode.VALIDATION, reservation.errorMessage);

      try {
        const now = new Date();
        await this.prisma.raw.$transaction(async (tx) => {
          const c = await tx.bill.updateMany({
            where: { id: input.billId, tenantId, status: { in: ['DRAFT', 'UNPAID'] }, paymentId: null },
            data: { status: 'CANCELED', canceledAt: now, canceledBy: input.adminId, cancelReason: input.reason },
          });
          if (c.count !== 1) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单状态已变更，不可作废');
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'ADMIN',
              actorId: input.adminId,
              action: 'CANCEL',
              resourceType: 'Bill',
              resourceId: input.billId,
              reason: input.reason,
              requestId: input.requestId,
              afterSummary: { status: 'CANCELED' },
            },
            tx,
          );
          await this.outbox.enqueue(
            {
              tenantId,
              communityId,
              aggregateType: 'Bill',
              aggregateId: input.billId,
              eventType: 'bill.canceled',
              dedupKey: `bill.canceled:${input.billId}`,
              payload: { billId: input.billId },
            },
            tx,
          );
        });
        const response = { billId: input.billId, status: 'CANCELED' };
        await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: response });
        return response;
      } catch (error) {
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : 'CANCEL_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  /** 重开账单：仅作废/已退款账单可重开，新账单以 replacesBillId 链接原账单。 */
  async reissueBill(input: ReissueBillInput): Promise<{ billId: string; replacesBillId: string; status: string }> {
    this.assertReason(input.reason);
    const bill = await this.prisma.raw.bill.findUnique({ where: { id: input.billId } });
    if (!bill) throw new BizException(ErrorCode.NOT_FOUND, '账单不存在');
    this.assertTenant(input.actingTenantId, bill.tenantId);
    if (!['CANCELED', 'REFUNDED'].includes(bill.status)) {
      throw new BizException(ErrorCode.VALIDATION, '仅作废或已退款账单可重开');
    }

    const tenantId = bill.tenantId;
    const communityId = bill.communityId;
    return runWithTenant(tenantId, async () => {
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: input.adminId,
        action: 'admin.bill.reissue',
        requestId: input.requestId,
        payload: { billId: input.billId },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody as { billId: string; replacesBillId: string; status: string };
      if (reservation.outcome === 'IN_PROGRESS') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '重开处理中，请稍候');
      if (reservation.outcome === 'FAILED') throw new BizException(ErrorCode.VALIDATION, reservation.errorMessage);

      try {
        const now = new Date();
        const dueDate = new Date(now);
        dueDate.setDate(dueDate.getDate() + 15);
        dueDate.setHours(23, 59, 59, 0);
        const created = await this.prisma.raw.$transaction(async (tx) => {
          /*
           * 重复守卫：同一房屋 + 同一账期 + 同一费用项，只允许有一张存活账单。
           *
           * 原守卫的维度是 { replacesBillId: bill.id }，即「一张原账单只能有一张
           * 存活的替代账单」。这挡不住链式重开：
           *   A 作废 → 重开得 B → B 作废 → 重开 B 得 C（查 replacesBillId=B，无存活）
           *   → 再重开 A（查 replacesBillId=A，只有 B 而 B 已 CANCELED，被 notIn 排除）
           *   → 得 D
           * 于是 C 与 D 同为 UNPAID、同房同期同费用项，业主两张都能付 —— 正是这个
           * 守卫要防的重复收款，只是换了条路径进来。
           *
           * 维度必须是「费用项」而不是「账期」：同房同期本来就允许多张账单
           * （物业费、占位费、水费各一张，唯一键 @@unique([ruleId,houseId,period])
           * 就是按费用项去重的）。按账期去重会直接打断多费项计费。
           *
           * 重开时 ruleId 置空（规避与原账单撞唯一键），原 ruleId 落在
           * snapshot.originalRuleId，所以要按「有效费用项」比对；两边都没有规则
           * （手工/导入账单）时退回按标题比对。
           *
           * 存活口径 notIn [CANCELED, REFUNDED]：REFUNDED 是「钱已退回」的终态，
           * 不构成待收，且它本身可被重开——若算作存活，重开 REFUNDED 账单会被
           * 自己挡住。
           */
          const effectiveRuleOf = (b: { ruleId: string | null; snapshot: unknown }): string | null => {
            if (b.ruleId) return b.ruleId;
            const snap = b.snapshot as { originalRuleId?: unknown } | null;
            return typeof snap?.originalRuleId === 'string' ? snap.originalRuleId : null;
          };
          const targetRule = effectiveRuleOf(bill);
          const siblings = await tx.bill.findMany({
            where: {
              tenantId,
              houseId: bill.houseId,
              period: bill.period,
              status: { notIn: ['CANCELED', 'REFUNDED'] },
            },
            select: { id: true, ruleId: true, snapshot: true, title: true, status: true },
          });
          const clash = siblings.find((s) =>
            targetRule === null && effectiveRuleOf(s) === null
              ? s.title === bill.title
              : effectiveRuleOf(s) === targetRule,
          );
          if (clash) {
            throw new BizException(
              ErrorCode.VALIDATION,
              `该房屋本期的「${clash.title}」已存在一张${clash.status === 'PAID' ? '已缴' : '待缴'}账单，` +
                '请先作废它再重开，避免业主重复缴费',
            );
          }
          // ruleId 置空以规避 (ruleId, houseId, period) 唯一键与原账单冲突；规则信息进快照。
          const c = await tx.bill.create({
            data: {
              tenantId,
              communityId,
              houseId: bill.houseId,
              ruleId: null,
              batchId: null,
              source: bill.source ?? 'RULE',
              period: bill.period,
              title: bill.title,
              snapshot: { ...(bill.snapshot as object), reissuedFrom: bill.id, originalRuleId: bill.ruleId } as never,
              amount: bill.amount as never,
              status: 'UNPAID',
              dueDate,
              publishedAt: now,
              publishedBy: input.adminId,
              replacesBillId: bill.id,
            },
          });
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'ADMIN',
              actorId: input.adminId,
              action: 'CREATE',
              resourceType: 'Bill',
              resourceId: c.id,
              reason: input.reason,
              requestId: input.requestId,
              afterSummary: { status: 'UNPAID', replacesBillId: bill.id, amount: String(bill.amount) },
            },
            tx,
          );
          await this.outbox.enqueue(
            {
              tenantId,
              communityId,
              aggregateType: 'Bill',
              aggregateId: c.id,
              eventType: 'bill.reissued',
              dedupKey: `bill.reissued:${c.id}`,
              payload: { billId: c.id, replacesBillId: bill.id },
            },
            tx,
          );
          return c;
        });
        const response = { billId: created.id, replacesBillId: bill.id, status: 'UNPAID' };
        await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: response });
        return response;
      } catch (error) {
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : 'REISSUE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }
}
