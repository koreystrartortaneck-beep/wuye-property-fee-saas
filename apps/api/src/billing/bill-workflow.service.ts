import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { BILL_NOTIFIER, BillNotifier, NoopBillNotifier } from '../notify/notify.tokens';
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
    @Optional() @Inject(BILL_NOTIFIER) private readonly notifier: BillNotifier = new NoopBillNotifier(),
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
        const { publishedCount, bills } = await this.prisma.raw.$transaction(async (tx) => {
          const b = await tx.billBatch.updateMany({
            where: { id: input.batchId, tenantId, status: { in: ['DRAFT', 'GENERATING', 'READY'] } },
            data: { status: 'PUBLISHED', publishedAt: now, publishedBy: input.adminId },
          });
          if (b.count !== 1) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '批次状态已变更');
          const drafts = await tx.bill.findMany({ where: { batchId: input.batchId, status: 'DRAFT' } });
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
          for (const bill of drafts) {
            await this.outbox.enqueue(
              {
                tenantId,
                communityId,
                aggregateType: 'Bill',
                aggregateId: bill.id,
                eventType: 'bill.published',
                dedupKey: `bill.published:${bill.id}`,
                payload: { billId: bill.id, houseId: bill.houseId, period: bill.period, amount: String(bill.amount) },
              },
              tx,
            );
          }
          return { publishedCount: upd.count, bills: drafts };
        });

        // 通知放在事务外：失败不回滚发布（NotifyLog 自记录，Outbox 事件已落库）。
        for (const bill of bills) {
          try {
            await this.notifier.onBillCreated(bill as never);
          } catch (e) {
            this.logger.warn(`发布通知失败 bill=${bill.id}: ${e instanceof Error ? e.message : e}`);
          }
        }

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
