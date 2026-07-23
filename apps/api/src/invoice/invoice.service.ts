import { Injectable } from '@nestjs/common';
import { ErrorCode, InvoiceApplicationStatus, InvoiceTitleType } from '@pf/shared';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { IdempotencyService } from '../common/idempotency.service';
import { OutboxService } from '../notify/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

/** 退款成功后联动开票申请（取消未开票 / 已开票转冲红），由退款事务复用。 */
export const INVOICE_REFUND_LINK = Symbol('INVOICE_REFUND_LINK');
export interface InvoiceRefundLink {
  onPaymentRefunded(tx: Prisma.TransactionClient, tenantId: string, paymentId: string): Promise<void>;
}

export interface ApplyInvoiceInput {
  orderNo: string;
  wxUserId: string;
  titleType: InvoiceTitleType;
  title: string;
  taxNo?: string | null;
  deliveryMethod: string;
  email?: string | null;
  requestId: string;
}

const TAX_NO_RE = /^[0-9A-Z]{15,20}$/;

/**
 * 开票申请：仅登记业主开票诉求与状态流转，本系统不声称开具税务发票。
 * 成功支付方可申请；(tenantId,paymentId) 唯一实现重复申请幂等；退款联动取消/冲红。
 */
@Injectable()
export class InvoiceService implements InvoiceRefundLink {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** 业主提交开票申请（幂等）。 */
  async apply(input: ApplyInvoiceInput) {
    if (!input.title || !input.title.trim()) throw new BizException(ErrorCode.VALIDATION, '发票抬头不能为空');
    if (input.titleType === 'ENTERPRISE') {
      if (!input.taxNo || !TAX_NO_RE.test(input.taxNo.trim())) {
        throw new BizException(ErrorCode.VALIDATION, '企业抬头需提供正确的税号');
      }
    }
    if (input.deliveryMethod === 'EMAIL' && !input.email) {
      throw new BizException(ErrorCode.VALIDATION, '邮寄电子发票需提供邮箱');
    }

    const payment = await this.prisma.raw.payment.findUnique({
      where: { orderNo: input.orderNo },
      include: { paymentBills: { include: { bill: { select: { communityId: true } } } } },
    });
    if (!payment) throw new BizException(ErrorCode.NOT_FOUND, '订单不存在');
    if (payment.wxUserId !== input.wxUserId) throw new BizException(ErrorCode.FORBIDDEN, '无权对该订单开票');
    if (payment.status !== 'SUCCESS') throw new BizException(ErrorCode.VALIDATION, '仅支付成功的订单可申请开票');

    const communityId = this.resolveCommunityId(payment);
    if (!communityId) throw new BizException(ErrorCode.VALIDATION, '跨小区历史订单暂不支持开票');
    const tenantId = payment.tenantId;

    return runWithTenant(tenantId, async () => {
      // 重复申请幂等：同订单已存在申请直接返回。
      const existing = await this.prisma.raw.invoiceApplication.findFirst({ where: { tenantId, paymentId: payment.id } });
      if (existing) return this.view(existing);

      const reservation = await this.idempotency.reserve({
        tenantId,
        communityId,
        actorKey: input.wxUserId,
        action: 'owner.invoice.apply',
        requestId: input.requestId,
        payload: { orderNo: input.orderNo },
      });
      if (reservation.outcome === 'REPLAY') return reservation.responseBody;
      if (reservation.outcome === 'IN_PROGRESS') throw new BizException(ErrorCode.VALIDATION, '开票申请处理中，请稍候');
      if (reservation.outcome === 'FAILED') throw new BizException(ErrorCode.VALIDATION, reservation.errorMessage);

      try {
        const applicationNo = `INV-${payment.orderNo}`;
        const created = await this.prisma.raw.$transaction(async (tx) => {
          const app = await tx.invoiceApplication.create({
            data: {
              tenantId,
              communityId,
              paymentId: payment.id,
              wxUserId: input.wxUserId,
              applicationNo,
              titleType: input.titleType,
              title: input.title.trim(),
              taxNo: input.taxNo?.trim() ?? null,
              deliveryMethod: input.deliveryMethod,
              email: input.email ?? null,
              amount: payment.totalAmount as never,
              status: 'SUBMITTED',
            },
          });
          await this.audit.append(
            {
              tenantId,
              communityId,
              actorType: 'WX_USER',
              actorId: input.wxUserId,
              action: 'INVOICE',
              resourceType: 'InvoiceApplication',
              resourceId: app.id,
              requestId: input.requestId,
              afterSummary: { applicationNo, status: 'SUBMITTED', titleType: input.titleType },
            },
            tx,
          );
          await this.outbox.enqueue(
            {
              tenantId,
              communityId,
              aggregateType: 'InvoiceApplication',
              aggregateId: app.id,
              eventType: 'invoice.submitted',
              dedupKey: `invoice.submitted:${app.id}`,
              payload: { applicationNo, paymentId: payment.id, wxUserId: input.wxUserId },
            },
            tx,
          );
          return app;
        });
        const response = this.view(created);
        await this.idempotency.complete({ tenantId, recordId: reservation.recordId, responseCode: 0, responseBody: response });
        return response;
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          const raced = await this.prisma.raw.invoiceApplication.findFirst({ where: { tenantId, paymentId: payment.id } });
          await this.idempotency.fail({ tenantId, recordId: reservation.recordId, errorCode: 'DUP', errorMessage: '重复申请' });
          if (raced) return this.view(raced);
        } else {
          await this.idempotency.fail({
            tenantId,
            recordId: reservation.recordId,
            errorCode: error instanceof BizException ? String(error.code) : 'INVOICE_FAILED',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    });
  }

  private resolveCommunityId(payment: { communityId: string | null; paymentBills: Array<{ bill: { communityId: string } }> }): string | null {
    if (payment.communityId) return payment.communityId;
    const set = new Set(payment.paymentBills.map((pb) => pb.bill.communityId));
    return set.size === 1 ? [...set][0] : null;
  }

  private view(app: {
    id: string; applicationNo: string; status: string; titleType: string; title: string;
    taxNo: string | null; amount: unknown; invoiceNo: string | null; appliedAt: Date; issuedAt: Date | null;
  }) {
    return {
      id: app.id,
      applicationNo: app.applicationNo,
      status: app.status,
      titleType: app.titleType,
      title: app.title,
      taxNo: app.taxNo,
      amount: String(app.amount),
      invoiceNo: app.invoiceNo,
      appliedAt: app.appliedAt,
      issuedAt: app.issuedAt,
    };
  }

  async listForOwner(wxUserId: string) {
    const apps = await this.prisma.raw.invoiceApplication.findMany({ where: { wxUserId }, orderBy: { appliedAt: 'desc' } });
    return apps.map((a) => this.view(a));
  }

  /** 管理端状态流转：PROCESSING / ISSUED / REJECTED（登记外部开票结果，不代开税票）。 */
  async transition(input: { id: string; adminId: string; actingTenantId: string | null; status: InvoiceApplicationStatus; invoiceNo?: string; invoiceUrl?: string; rejectReason?: string }) {
    const app = await this.prisma.raw.invoiceApplication.findUnique({ where: { id: input.id } });
    if (!app) throw new BizException(ErrorCode.NOT_FOUND, '开票申请不存在');
    if (input.actingTenantId !== null && input.actingTenantId !== app.tenantId) {
      throw new BizException(ErrorCode.FORBIDDEN, '无权处理该开票申请');
    }
    const allowed: Record<string, InvoiceApplicationStatus[]> = {
      SUBMITTED: ['PROCESSING', 'ISSUED', 'REJECTED'],
      PROCESSING: ['ISSUED', 'REJECTED'],
      REVERSAL_REQUIRED: ['REVERSED'],
    };
    if (!(allowed[app.status] ?? []).includes(input.status)) {
      throw new BizException(ErrorCode.VALIDATION, `开票状态 ${app.status} 不允许流转到 ${input.status}`);
    }
    return runWithTenant(app.tenantId, async () => {
      return this.prisma.raw.$transaction(async (tx) => {
        const now = new Date();
        const data: Prisma.InvoiceApplicationUncheckedUpdateInput = { status: input.status, processedBy: input.adminId };
        if (input.status === 'ISSUED') { data.issuedAt = now; data.invoiceNo = input.invoiceNo ?? null; data.invoiceUrl = input.invoiceUrl ?? null; }
        if (input.status === 'REJECTED') { data.rejectedAt = now; data.rejectReason = input.rejectReason ?? '未通过'; }
        if (input.status === 'REVERSED') { data.reversedAt = now; data.reversalRemark = input.rejectReason ?? null; }
        const updated = await tx.invoiceApplication.updateMany({ where: { id: input.id, tenantId: app.tenantId, status: app.status }, data });
        if (updated.count !== 1) throw new BizException(ErrorCode.VALIDATION, '开票申请状态已变更');
        await this.audit.append(
          {
            tenantId: app.tenantId,
            communityId: app.communityId,
            actorType: 'ADMIN',
            actorId: input.adminId,
            action: 'INVOICE',
            resourceType: 'InvoiceApplication',
            resourceId: input.id,
            afterSummary: { status: input.status, invoiceNo: input.invoiceNo ?? null },
          },
          tx,
        );
        await this.outbox.enqueue(
          {
            tenantId: app.tenantId,
            communityId: app.communityId,
            aggregateType: 'InvoiceApplication',
            aggregateId: input.id,
            eventType: `invoice.${input.status.toLowerCase()}`,
            dedupKey: `invoice.${input.status.toLowerCase()}:${input.id}`,
            payload: { applicationNo: app.applicationNo, wxUserId: app.wxUserId, status: input.status },
          },
          tx,
        );
        return { id: input.id, status: input.status };
      });
    });
  }

  /** 退款成功联动：未开票申请置 CANCELED；已开票（ISSUED）转 REVERSAL_REQUIRED 生成冲红任务。事务内复用。 */
  async onPaymentRefunded(tx: Prisma.TransactionClient, tenantId: string, paymentId: string): Promise<void> {
    const app = await tx.invoiceApplication.findFirst({ where: { tenantId, paymentId } });
    if (!app) return;
    const now = new Date();
    if (['SUBMITTED', 'PROCESSING'].includes(app.status)) {
      await tx.invoiceApplication.updateMany({ where: { id: app.id, status: app.status }, data: { status: 'CANCELED' } });
      await this.audit.append(
        { tenantId, communityId: app.communityId, actorType: 'SYSTEM', action: 'INVOICE', resourceType: 'InvoiceApplication', resourceId: app.id, afterSummary: { status: 'CANCELED', reason: 'refund' } },
        tx,
      );
    } else if (app.status === 'ISSUED') {
      await tx.invoiceApplication.updateMany({ where: { id: app.id, status: 'ISSUED' }, data: { status: 'REVERSAL_REQUIRED', reversalRequiredAt: now } });
      await this.audit.append(
        { tenantId, communityId: app.communityId, actorType: 'SYSTEM', action: 'INVOICE', resourceType: 'InvoiceApplication', resourceId: app.id, afterSummary: { status: 'REVERSAL_REQUIRED', reason: 'refund' } },
        tx,
      );
    }
  }
}
