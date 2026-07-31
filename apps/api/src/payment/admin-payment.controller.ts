import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PAYMENT_CHANNELS, PAYMENT_STATUSES, PaymentChannel, PaymentStatus } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { OfflinePaymentService } from './offline-payment.service';

class SettleOfflineDto {
  @IsString()
  @IsNotEmpty()
  billId!: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  voucherNo!: string;

  @Type(() => Date)
  @IsDate()
  paidAt!: Date;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  payerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  remark?: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

class ReverseOfflineDto {
  @IsString()
  @MaxLength(191)
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

class ListPaymentsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(PAYMENT_CHANNELS as unknown as string[])
  channel?: PaymentChannel;

  @IsOptional()
  @IsIn(PAYMENT_STATUSES as unknown as string[])
  status?: PaymentStatus;
}

@Injectable()
export class AdminPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListPaymentsQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.payment.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        select: {
          orderNo: true, totalAmount: true, discountAmount: true, channel: true, status: true, paidAt: true,
          offlineVoucherNo: true, receiptNo: true, createdAt: true, billId: true,
          /*
           * 带出房屋与费用名称。原先这个列表只有「账单 ID」（一串 cuid）——
           * 收费员核一笔款要拿这个 ID 去别处反查是哪户的哪笔费用，而后台界面上
           * 根本不显示账单 ID。房号才是他们唯一认得的标识。
           */
          bill: {
            select: {
              title: true,
              period: true,
              house: { select: { id: true, code: true, displayName: true } },
            },
          },
        },
      }),
      this.prisma.t.payment.count({ where }),
    ]);
    return pageResult(list, total, q);
  }
}

@Controller('admin/payments')
@UseGuards(AdminGuard, RolesGuard)
export class AdminPaymentController {
  constructor(
    private readonly offline: OfflinePaymentService,
    private readonly payments: AdminPaymentsService,
  ) {}

  @Get()
  list(@Query() q: ListPaymentsQuery) {
    return this.payments.list(q);
  }

  @Post('offline')
  settleOffline(@Current() cur: CurrentAdmin, @Body() dto: SettleOfflineDto) {
    return this.offline.settleOffline({
      billId: dto.billId,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      voucherNo: dto.voucherNo,
      paidAt: dto.paidAt,
      payerName: dto.payerName,
      remark: dto.remark,
      requestId: dto.requestId,
    });
  }

  /*
   * 冲正把已收的线下款作废（账单回到未缴），等同于资金出账，限定 TENANT_ADMIN。
   * 线下现金核销（上面的 /offline）刻意不限制：那是收费员的日常工作，
   * 且它只会把账单从未缴改成已缴、不会把钱退出去，风险方向相反。
   */
  @Roles('TENANT_ADMIN')
  @Post(':orderNo/reverse-offline')
  reverseOffline(@Current() cur: CurrentAdmin, @Param('orderNo') orderNo: string, @Body() dto: ReverseOfflineDto) {
    return this.offline.reverseOffline({
      orderNo,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      reason: dto.reason,
      requestId: dto.requestId,
    });
  }
}
