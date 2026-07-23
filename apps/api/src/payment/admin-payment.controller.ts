import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PAYMENT_CHANNELS, PAYMENT_STATUSES, PaymentChannel, PaymentStatus } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { OfflinePaymentService } from './offline-payment.service';

class SettleOfflineDto {
  @IsString()
  @IsNotEmpty()
  billId!: string;

  @IsString()
  @IsNotEmpty()
  voucherNo!: string;

  @Type(() => Date)
  @IsDate()
  paidAt!: Date;

  @IsOptional()
  @IsString()
  payerName?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

class ReverseOfflineDto {
  @IsString()
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
          orderNo: true, totalAmount: true, channel: true, status: true, paidAt: true,
          offlineVoucherNo: true, receiptNo: true, createdAt: true, billId: true,
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
