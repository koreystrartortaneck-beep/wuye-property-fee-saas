import { Controller, Get, Headers, Post } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { RefundService } from '../payment/refund.service';

/**
 * 一次性灰度联调引导端点（无 WebShell 时用）。
 * 以 JWT_SECRET 作为调用口令（x-bootstrap-token 头必须等于 JWT_SECRET），
 * 幂等创建：港城物业 / 金港城 / 测试房屋(业主手机号) / 1 分钱账单 / 租户管理员。
 * 联调完成后应移除本模块。
 */
const PHONE = '18722961375';
const ADMIN_USER = 'gangcheng';
const ADMIN_PW = 'GangCheng2026';

@Controller('ops/pilot-bootstrap')
export class PilotBootstrapController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refundService: RefundService,
  ) {}

  private assert(token?: string) {
    const expected = process.env.JWT_SECRET || '';
    if (!expected || !token || token !== expected) {
      throw new BizException(ErrorCode.NOT_FOUND); // 不暴露端点存在
    }
  }

  /** 只读盘点：列出全部租户/小区/房屋/未支付账单，用于对齐真机已绑的那套数据。 */
  @Get('inspect')
  async inspect(@Headers('x-bootstrap-token') token?: string) {
    this.assert(token);
    const p = this.prisma.raw;
    const tenants = await p.tenant.findMany({ select: { id: true, name: true, code: true } });
    const communities = await p.community.findMany({
      select: { id: true, name: true, tenantId: true },
    });
    const houses = await p.house.findMany({
      select: {
        id: true, code: true, displayName: true, ownerPhone: true, status: true,
        tenantId: true, communityId: true,
      },
    });
    const bills = await p.bill.findMany({
      where: { status: 'UNPAID' },
      select: {
        id: true, title: true, period: true, amount: true, status: true,
        tenantId: true, communityId: true, houseId: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const payments = await p.payment.findMany({
      select: {
        id: true, orderNo: true, status: true, totalAmount: true, channel: true,
        transactionId: true, wxpayNotifiedAt: true, confirmedBy: true, paidAt: true, createdAt: true,
        expiresAt: true, failureCode: true, failureMessage: true,
        receiptSnapshot: true, tenantId: true, communityId: true, wxUserId: true,
        paymentBills: { select: { billId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const paymentView = payments.map((x: Record<string, unknown>) => ({
      id: x.id, orderNo: x.orderNo, status: x.status, totalAmount: x.totalAmount, channel: x.channel,
      hasTransactionId: !!x.transactionId, wxpayNotifiedAt: x.wxpayNotifiedAt, confirmedBy: x.confirmedBy,
      paidAt: x.paidAt, createdAt: x.createdAt, expiresAt: x.expiresAt,
      failureCode: x.failureCode, failureMessage: x.failureMessage,
      hasReceipt: !!x.receiptSnapshot,
      billIds: (x.paymentBills as { billId: string }[]).map((b) => b.billId),
    }));
    // 最近账单（含各状态，用于核对退款后账单回退）
    const recentBills = await p.bill.findMany({
      select: { id: true, title: true, status: true, tenantId: true, houseId: true, paidAt: true, paymentId: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    // 退款单
    const refunds = await p.refund.findMany({
      select: {
        refundNo: true, status: true, refundAmount: true, providerRefundId: true,
        notifyReceivedAt: true, refundedAt: true, failureCode: true, failureMessage: true,
        paymentId: true, billId: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    // 支付/退款事件（回调证据）
    const events = await p.paymentEvent.findMany({
      select: {
        eventKey: true, type: true, status: true, source: true, paymentId: true,
        refundId: true, occurredAt: true, processedAt: true, lastError: true,
      },
      orderBy: { occurredAt: 'desc' },
      take: 30,
    });
    // 回调验签失败告警（若微信推了但被拒，会在这里）
    const alerts = await p.operationalAlert.findMany({
      where: { alertType: { in: ['PAYMENT_CALLBACK_REJECTED', 'REFUND_CALLBACK_REJECTED'] } },
      select: {
        alertType: true, severity: true, title: true, summary: true, status: true,
        occurrences: true, firstSeenAt: true, lastSeenAt: true,
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 20,
    });
    const scope = {
      WX_PAY_ALLOWED_TENANT_ID: process.env.WX_PAY_ALLOWED_TENANT_ID || null,
      WX_PAY_ALLOWED_COMMUNITY_ID: process.env.WX_PAY_ALLOWED_COMMUNITY_ID || null,
      WX_PAY_NOTIFY_URL: process.env.WX_PAY_NOTIFY_URL || null,
      WX_PAY_REFUND_NOTIFY_URL: process.env.WX_PAY_REFUND_NOTIFY_URL || null,
      WX_PAY_PUBLIC_KEY_ID: process.env.WX_PAY_PUBLIC_KEY_ID || null,
      PAY_MODE: process.env.PAY_MODE || null,
    };
    return {
      tenants, communities, houses, unpaidBills: bills, recentBills,
      payments: paymentView, refunds, paymentEvents: events, callbackAlerts: alerts, scope,
    };
  }

  /** 给指定房屋补一张 1 分钱未支付测试账单（幂等）。 */
  @Post('bill')
  async makeBill(
    @Headers('x-bootstrap-token') token?: string,
    @Headers('x-house-id') houseId?: string,
  ) {
    this.assert(token);
    const p = this.prisma.raw;
    if (!houseId) throw new BizException(ErrorCode.NOT_FOUND);
    const house = await p.house.findUnique({ where: { id: houseId } });
    if (!house) throw new BizException(ErrorCode.NOT_FOUND);
    let bill = await p.bill.findFirst({
      where: { houseId: house.id, period: '2026-07', title: '物业费（联调测试）' },
    });
    if (!bill) {
      bill = await p.bill.create({
        data: {
          tenantId: house.tenantId, communityId: house.communityId, houseId: house.id,
          period: '2026-07', title: '物业费（联调测试）', amount: '0.01',
          dueDate: new Date(Date.now() + 30 * 86400000), status: 'UNPAID', source: 'IMPORT', snapshot: {},
        },
      });
    }
    return {
      billId: bill.id, houseId: house.id, tenantId: house.tenantId, communityId: house.communityId,
      status: bill.status, amount: bill.amount,
    };
  }

  /**
   * 对指定订单发起真实全额退款（走真实 RefundService：幂等/审计/微信外呼）。
   * 幂等：为订单所属租户就位一个运维管理员作为 adminId，requestId 固定以复用同一退款单。
   */
  @Post('refund')
  async refund(
    @Headers('x-bootstrap-token') token?: string,
    @Headers('x-order-no') orderNo?: string,
  ) {
    this.assert(token);
    const p = this.prisma.raw;
    if (!orderNo) throw new BizException(ErrorCode.VALIDATION, '缺少 x-order-no');
    const payment = await p.payment.findUnique({
      where: { orderNo },
      select: { id: true, tenantId: true, status: true, channel: true },
    });
    if (!payment) throw new BizException(ErrorCode.NOT_FOUND, '订单不存在');

    // 为该租户就位一个运维管理员（幂等），作为退款审计的 adminId
    const opsUser = 'pilotops';
    const opsHash = await bcrypt.hash('PilotOps2026x', 10);
    const existingOps = await p.adminUser.findUnique({ where: { username: opsUser } });
    let adminId: string;
    if (existingOps) {
      await p.adminUser.update({
        where: { username: opsUser },
        data: { status: 'ACTIVE', tenantId: payment.tenantId, role: 'TENANT_ADMIN', mustChangePassword: false },
      });
      adminId = existingOps.id;
    } else {
      const created = await p.adminUser.create({
        data: { username: opsUser, passwordHash: opsHash, name: '联调运维', role: 'TENANT_ADMIN', tenantId: payment.tenantId, mustChangePassword: false },
      });
      adminId = created.id;
    }

    const result = await this.refundService.createRefund({
      orderNo,
      adminId,
      actingTenantId: payment.tenantId,
      reason: '联调测试退款',
      requestId: `pilot-refund-${orderNo}`,
    });
    return { orderNo, paymentStatusBefore: payment.status, refund: result };
  }

  /** 强制查退款终态（不等 10 分钟定时任务）：调真实 recoverRefund 查微信并推进 SUCCESS/FAILED。 */
  @Post('refund-sync')
  async refundSync(
    @Headers('x-bootstrap-token') token?: string,
    @Headers('x-refund-no') refundNo?: string,
  ) {
    this.assert(token);
    if (!refundNo) throw new BizException(ErrorCode.VALIDATION, '缺少 x-refund-no');
    const result = await this.refundService.recoverRefund(refundNo);
    return { refundNo, result };
  }

  @Post()
  async run(@Headers('x-bootstrap-token') token?: string) {
    this.assert(token);
    const p = this.prisma.raw;

    let tenant = await p.tenant.findUnique({ where: { code: 'gangcheng' } });
    if (!tenant) {
      tenant = await p.tenant.create({
        data: { name: '港城物业', code: 'gangcheng', contactName: '物业客服', contactPhone: PHONE },
      });
    }
    let community = await p.community.findFirst({ where: { tenantId: tenant.id, name: '金港城' } });
    if (!community) {
      community = await p.community.create({
        data: { tenantId: tenant.id, name: '金港城', address: '金港城小区', servicePhone: PHONE },
      });
    }
    let house = await p.house.findFirst({
      where: { tenantId: tenant.id, communityId: community.id, code: 'JGC-1-101' },
    });
    if (!house) {
      house = await p.house.create({
        data: {
          tenantId: tenant.id, communityId: community.id, code: 'JGC-1-101',
          displayName: '1 栋 1 单元 101', ownerName: '测试业主', ownerPhone: PHONE,
          type: 'RESIDENCE', area: '88.00',
        },
      });
    }
    let bill = await p.bill.findFirst({
      where: { tenantId: tenant.id, houseId: house.id, period: '2026-07', title: '物业费（联调测试）' },
    });
    if (!bill) {
      bill = await p.bill.create({
        data: {
          tenantId: tenant.id, communityId: community.id, houseId: house.id,
          period: '2026-07', title: '物业费（联调测试）', amount: '0.01',
          dueDate: new Date(Date.now() + 30 * 86400000), status: 'UNPAID', source: 'IMPORT', snapshot: {},
        },
      });
    }
    const hash = await bcrypt.hash(ADMIN_PW, 10);
    const existing = await p.adminUser.findUnique({ where: { username: ADMIN_USER } });
    if (existing) {
      await p.adminUser.update({
        where: { username: ADMIN_USER },
        data: { passwordHash: hash, status: 'ACTIVE', mustChangePassword: false, tenantId: tenant.id, role: 'TENANT_ADMIN', tokenVersion: { increment: 1 } },
      });
    } else {
      await p.adminUser.create({
        data: { username: ADMIN_USER, passwordHash: hash, name: '港城物业管理员', role: 'TENANT_ADMIN', tenantId: tenant.id, mustChangePassword: false },
      });
    }

    const scopeTenant = process.env.WX_PAY_ALLOWED_TENANT_ID || null;
    const scopeCommunity = process.env.WX_PAY_ALLOWED_COMMUNITY_ID || null;

    return {
      tenantId: tenant.id,
      communityId: community.id,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PW,
      billId: bill.id,
      ownerPhone: PHONE,
      // 支付商户范围自检：两项都为 true 才能付款
      payScope: {
        tenantEnvSet: scopeTenant !== null,
        communityEnvSet: scopeCommunity !== null,
        tenantMatches: scopeTenant === tenant.id,
        communityMatches: scopeCommunity === community.id,
        ready: scopeTenant === tenant.id && scopeCommunity === community.id,
      },
    };
  }
}
