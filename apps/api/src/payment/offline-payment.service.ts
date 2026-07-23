import { Inject, Injectable, Optional } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { BILL_ORDER_CLOSER, BillOrderCloser } from '../billing/bill-workflow.service';

const ACTIVE_PAYMENT_STATUSES = ['CREATED', 'PREPAY_UNKNOWN'];

export interface SettleOfflineInput {
  billId: string;
  adminId: string;
  actingTenantId: string | null;
  voucherNo: string;
  paidAt: string | Date;
  payerName?: string | null;
  remark?: string | null;
  requestId: string;
}

export interface ReverseOfflineInput {
  orderNo: string;
  adminId: string;
  actingTenantId: string | null;
  reason: string;
  requestId: string;
}

/**
 * 线下缴费核销与冲正。
 * - 核销：一事务内建 SUCCESS/OFFLINE 支付 + 不可变收据快照并预占账单；凭证号唯一。
 * - 冲正：复用退款聚合（channel=OFFLINE）直接终态成功，不调用微信。
 * - 收款暂停只拦线上新发起支付，不影响线下核销（记录已收现金）。
 */
@Injectable()
export class OfflinePaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    @Optional() @Inject(BILL_ORDER_CLOSER) private readonly orderCloser: BillOrderCloser | null = null,
  ) {}

  private assertTenant(actingTenantId: string | null, ownerTenantId: string): void {
    if (actingTenantId !== null && actingTenantId !== ownerTenantId) {
      throw new BizException(ErrorCode.FORBIDDEN, '无权操作该租户');
    }
  }

  private genOrderNo(): string {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    return `OFF${ymd}${rand}`;
  }

  private buildReceipt(
    orderNo: string,
    bill: { title: string; period: string; amount: unknown; house?: { displayName?: string | null; community?: { name?: string | null } | null } | null },
    totalAmount: string,
    paidAt: Date,
    voucherNo: string,
  ): { receiptNo: string; snapshot: Prisma.InputJsonObject } {
    const receiptNo = `RCPT-${orderNo}`;
    const snapshot: Prisma.InputJsonObject = {
      receiptNo,
      orderNo,
      channel: 'OFFLINE',
      voucherNo,
      totalAmount,
      paidAt: paidAt.toISOString(),
      community: bill.house?.community?.name ?? null,
      house: bill.house?.displayName ?? null,
      bills: [{ title: bill.title, period: bill.period, amount: String(bill.amount) }],
      issuedAt: new Date().toISOString(),
    };
    return { receiptNo, snapshot };
  }

  /** 线下核销：将 UNPAID 账单以线下凭证核销为 PAID，生成 SUCCESS/OFFLINE 支付与收据。 */
  async settleOffline(input: SettleOfflineInput): Promise<{ orderNo: string; receiptNo: string; status: 'SUCCESS' }> {
    if (!input.voucherNo || !input.voucherNo.trim()) throw new BizException(ErrorCode.VALIDATION, '缺少线下缴费凭证号');
    const paidAt = new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime())) throw new BizException(ErrorCode.VALIDATION, '缺少或非法的缴费时间');

    const initial = await this.prisma.raw.bill.findUnique({
      where: { id: input.billId },
      include: { house: { include: { community: { select: { name: true } } } } },
    });
    if (!initial) throw new BizException(ErrorCode.NOT_FOUND, '账单不存在');
    this.assertTenant(input.actingTenantId, initial.tenantId);

    const tenantId = initial.tenantId;
    const communityId = initial.communityId;
    const payerSnapshot = { payerName: input.payerName ?? null, remark: input.remark ?? null, operatorId: input.adminId };

    return runWithTenant(tenantId, async () => {
      // 幂等复核须早于状态/占用校验：重放应返回已存结果，而不是被自己首个核销产生的 PAID 挡回。
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: input.adminId,
        action: 'admin.offline.settle',
        requestId: input.requestId,
        payload: { billId: input.billId, voucherNo: input.voucherNo },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody as { orderNo: string; receiptNo: string; status: 'SUCCESS' };
      if (reservation.outcome === 'IN_PROGRESS') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '核销处理中，请稍候');
      if (reservation.outcome === 'FAILED') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, reservation.errorMessage);

      try {
        let bill = initial;
        if (bill.status !== 'UNPAID') throw new BizException(ErrorCode.BILL_NOT_PAYABLE, '仅未缴账单可线下核销');
        // 进行中的线上订单占用账单：先查关，成功回调则拒绝核销。
        if (bill.paymentId) {
          if (!this.orderCloser) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单存在进行中的线上支付');
          const active = await this.prisma.raw.payment.findUnique({ where: { id: bill.paymentId } });
          if (active) await this.orderCloser.resolveActiveOrder(active.orderNo);
          const reloaded = await this.prisma.raw.bill.findUnique({
            where: { id: input.billId },
            include: { house: { include: { community: { select: { name: true } } } } },
          });
          if (!reloaded) throw new BizException(ErrorCode.NOT_FOUND, '账单不存在');
          if (reloaded.status === 'PAID') throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单已支付，不可重复核销');
          if (reloaded.paymentId) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单仍被进行中的支付占用');
          bill = reloaded;
        }
        const totalAmount = String(bill.amount);
        const orderNo = this.genOrderNo();
        const { receiptNo, snapshot } = this.buildReceipt(orderNo, bill, totalAmount, paidAt, input.voucherNo);
        const result = await this.prisma.raw.$transaction(async (tx) => {
          const payment = await tx.payment.create({
            data: {
              tenantId,
              communityId,
              billId: input.billId,
              orderNo,
              totalAmount,
              channel: 'OFFLINE',
              status: 'SUCCESS',
              confirmedBy: 'OFFLINE',
              confirmedAt: new Date(),
              paidAt,
              offlineVoucherNo: input.voucherNo,
              offlinePaidAt: paidAt,
              offlineOperatorId: input.adminId,
              offlinePayerSnapshot: payerSnapshot as never,
              offlineRemark: input.remark ?? null,
              receiptNo,
              receiptSnapshot: snapshot,
            },
          });
          const reserved = await tx.bill.updateMany({
            where: { id: input.billId, status: 'UNPAID', paymentId: null },
            data: { status: 'PAID', paidAt, paymentId: payment.id },
          });
          if (reserved.count !== 1) throw new BizException(ErrorCode.PAYMENT_STATE_INVALID, '账单已被其他支付占用');
          await tx.paymentBill.create({ data: { paymentId: payment.id, billId: input.billId } });
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'ADMIN',
              actorId: input.adminId,
              action: 'PAY',
              resourceType: 'Payment',
              resourceId: payment.id,
              requestId: input.requestId,
              afterSummary: { orderNo, channel: 'OFFLINE', voucherNo: input.voucherNo, totalAmount },
            },
            tx,
          );
          return { orderNo, receiptNo };
        });
        const response = { orderNo: result.orderNo, receiptNo: result.receiptNo, status: 'SUCCESS' as const };
        await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: response });
        return response;
      } catch (error) {
        const code = (error as { code?: string }).code;
        const message =
          code === 'P2002' ? '线下缴费凭证号已存在' : error instanceof Error ? error.message : String(error);
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : code === 'P2002' ? 'VOUCHER_DUP' : 'OFFLINE_SETTLE_FAILED',
          errorMessage: message,
        });
        if (code === 'P2002') throw new BizException(ErrorCode.VALIDATION, '线下缴费凭证号已存在');
        throw error;
      }
    });
  }

  /** 线下冲正：复用退款聚合（OFFLINE）直接终态成功，不外呼微信。 */
  async reverseOffline(input: ReverseOfflineInput): Promise<{ refundNo: string; status: 'SUCCESS' }> {
    if (!input.reason || !input.reason.trim()) throw new BizException(ErrorCode.VALIDATION, '必须填写冲正原因');
    const payment = await this.prisma.raw.payment.findUnique({ where: { orderNo: input.orderNo } });
    if (!payment) throw new BizException(ErrorCode.NOT_FOUND, '订单不存在');
    this.assertTenant(input.actingTenantId, payment.tenantId);
    if (payment.channel !== 'OFFLINE') throw new BizException(ErrorCode.REFUND_STATE_INVALID, '仅线下缴费订单可线下冲正');
    if (payment.status === 'REFUNDED') return { refundNo: `RF-${payment.orderNo}`, status: 'SUCCESS' };
    if (payment.status !== 'SUCCESS') throw new BizException(ErrorCode.REFUND_STATE_INVALID, '仅成功的线下缴费可冲正');

    const tenantId = payment.tenantId;
    const communityId = payment.communityId;
    const amount = String(payment.totalAmount);

    return runWithTenant(tenantId, async () => {
      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: input.adminId,
        action: 'admin.offline.reverse',
        requestId: input.requestId,
        payload: { orderNo: input.orderNo },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody as { refundNo: string; status: 'SUCCESS' };
      if (reservation.outcome === 'IN_PROGRESS') throw new BizException(ErrorCode.REFUND_STATE_INVALID, '冲正处理中，请稍候');
      if (reservation.outcome === 'FAILED') throw new BizException(ErrorCode.REFUND_STATE_INVALID, reservation.errorMessage);

      try {
        const refundNo = `RF-${payment.orderNo}`;
        await this.prisma.raw.$transaction(async (tx) => {
          await tx.refund.create({
            data: {
              tenantId,
              communityId,
              paymentId: payment.id,
              paymentOrderNo: payment.orderNo,
              billId: payment.billId ?? null,
              merchantAccountId: 'OFFLINE',
              mchid: 'OFFLINE',
              appid: 'OFFLINE',
              refundNo,
              type: 'FULL',
              originalAmount: amount,
              refundAmount: amount,
              currency: 'CNY',
              reason: input.reason,
              channel: 'OFFLINE',
              status: 'SUCCESS',
              requestedBy: input.adminId,
              refundedAt: new Date(),
            },
          });
          await tx.payment.updateMany({ where: { id: payment.id, status: 'SUCCESS' }, data: { status: 'REFUNDED' } });
          await tx.bill.updateMany({ where: { paymentId: payment.id, status: { in: ['PAID', 'REFUNDING'] } }, data: { status: 'REFUNDED' } });
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'ADMIN',
              actorId: input.adminId,
              action: 'REFUND',
              resourceType: 'Refund',
              resourceId: refundNo,
              reason: input.reason,
              requestId: input.requestId,
              afterSummary: { refundNo, channel: 'OFFLINE', status: 'SUCCESS', refundAmount: amount },
            },
            tx,
          );
        });
        const response = { refundNo, status: 'SUCCESS' as const };
        await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: response });
        return response;
      } catch (error) {
        await this.idempotency.fail({
          tenantId,
          recordId: reservation.recordId,
          errorCode: error instanceof BizException ? String(error.code) : 'OFFLINE_REVERSE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }
}
