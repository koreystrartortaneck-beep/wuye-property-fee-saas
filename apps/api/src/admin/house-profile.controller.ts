import { Controller, Get, Injectable, Param, UseGuards } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { centsToStr, toCents } from '../billing/engine/money';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 住户档案：一个房屋的全部信息聚合到一次请求。
 *
 * 动因：所有页面都是「按单据」的横向列表（账单列表、支付列表、工单列表…），
 * 但收费员接到电话时是「按人找」——要在多个页面间手工拼条件才能回答
 * 「这户欠多少、交过几次、有没有报修」。此接口把这些一次给全。
 */
@Injectable()
export class HouseProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(houseId: string) {
    const house = await this.prisma.t.house.findUnique({
      where: { id: houseId },
      include: { community: { select: { id: true, name: true, servicePhone: true } } },
    });
    if (!house) throw new BizException(ErrorCode.NOT_FOUND, '房屋不存在');

    const [bills, bindings, tickets] = await Promise.all([
      this.prisma.t.bill.findMany({
        where: { houseId },
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
        take: 100,
        select: {
          id: true,
          title: true,
          period: true,
          amount: true,
          status: true,
          dueDate: true,
          paidAt: true,
          snapshot: true,
          paymentId: true,
        },
      }),
      this.prisma.t.houseBinding.findMany({
        where: { houseId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          status: true,
          relation: true,
          source: true,
          applicantName: true,
          createdAt: true,
          reviewedAt: true,
          wxUser: { select: { id: true, phone: true, nickname: true } },
        },
      }),
      this.prisma.t.ticket.findMany({
        where: { houseId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, type: true, status: true, content: true, createdAt: true, doneAt: true },
      }),
    ]);

    // PaymentBill 是无 tenantId 的关联表，不在租户模型清单内，必须用 raw；
    // 安全性由上游保证：billId 已限定为「本租户该房屋」的账单集合。
    const paymentLinks = await this.prisma.raw.paymentBill.findMany({
      where: { billId: { in: bills.map((b) => b.id) } },
      select: { paymentId: true },
    });
    const paymentIds = [...new Set(paymentLinks.map((p) => p.paymentId))];
    const payments = paymentIds.length
      ? await this.prisma.t.payment.findMany({
          where: { id: { in: paymentIds } },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            orderNo: true,
            status: true,
            channel: true,
            totalAmount: true,
            paidAt: true,
            createdAt: true,
            receiptNo: true,
          },
        })
      : [];

    // 开票申请无 houseId 字段，只能经该房屋的支付订单反查
    const invoices = paymentIds.length
      ? await this.prisma.t.invoiceApplication.findMany({
          where: { paymentId: { in: paymentIds } },
          orderBy: { appliedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            applicationNo: true,
            status: true,
            titleType: true,
            title: true,
            amount: true,
            invoiceNo: true,
            appliedAt: true,
          },
        })
      : [];

    // 汇总：欠费/已缴，口径与欠费清单一致（只算 UNPAID 与 PAID）
    let unpaidCents = 0;
    let unpaidCount = 0;
    let paidCents = 0;
    let paidCount = 0;
    for (const b of bills) {
      const cents = toCents(b.amount.toString());
      if (b.status === 'UNPAID') {
        unpaidCents += cents;
        unpaidCount += 1;
      } else if (b.status === 'PAID') {
        paidCents += cents;
        paidCount += 1;
      }
    }

    return {
      house: {
        id: house.id,
        code: house.code,
        displayName: house.displayName,
        type: house.type,
        area: house.area?.toString() ?? null,
        status: house.status,
        ownerName: house.ownerName,
        ownerPhone: house.ownerPhone,
        communityId: house.community?.id ?? null,
        communityName: house.community?.name ?? null,
        servicePhone: house.community?.servicePhone ?? null,
      },
      summary: {
        unpaidAmount: centsToStr(unpaidCents),
        unpaidCount,
        paidAmount: centsToStr(paidCents),
        paidCount,
        openTickets: tickets.filter((t) => t.status === 'PENDING' || t.status === 'PROCESSING').length,
        pendingBindings: bindings.filter((b) => b.status === 'PENDING').length,
      },
      bills,
      payments,
      bindings,
      tickets,
      invoices,
    };
  }
}

@Controller('admin/house-profile')
@UseGuards(AdminGuard, RolesGuard)
export class HouseProfileController {
  constructor(private readonly service: HouseProfileService) {}

  @Get(':houseId')
  get(@Param('houseId') houseId: string) {
    return this.service.profile(houseId);
  }
}
