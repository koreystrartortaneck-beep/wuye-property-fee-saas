import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { INVOICE_APPLICATION_STATUSES, InvoiceApplicationStatus } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { InvoiceService } from './invoice.service';

class ListInvoicesQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(INVOICE_APPLICATION_STATUSES as unknown as string[])
  status?: InvoiceApplicationStatus;
}

class TransitionDto {
  @IsIn(['PROCESSING', 'ISSUED', 'REJECTED', 'REVERSED'])
  status!: InvoiceApplicationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  invoiceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  rejectReason?: string;
}

@Injectable()
export class AdminInvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListInvoicesQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.invoiceApplication.findMany({
        where,
        ...pageArgs(q),
        orderBy: { appliedAt: 'desc' },
        /*
         * 带出房屋。开票申请只关联 payment，房屋要经 payment → bill → house 两跳。
         * 原先列表里既没有房号也没有费用名称，物业处理开票时无从判断这是哪户的哪笔费用
         * ——而抬头是业主自填的公司名或个人名，对不上房号。
         */
        include: {
          payment: {
            select: {
              orderNo: true,
              bill: {
                select: {
                  title: true,
                  period: true,
                  house: { select: { id: true, code: true, displayName: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.t.invoiceApplication.count({ where }),
    ]);
    return pageResult(list, total, q);
  }
}

@Controller('admin/invoices')
@UseGuards(AdminGuard, RolesGuard)
export class AdminInvoiceController {
  constructor(
    private readonly service: InvoiceService,
    private readonly read: AdminInvoiceService,
  ) {}

  @Get()
  list(@Query() q: ListInvoicesQuery) {
    return this.read.list(q);
  }

  @Post(':id/transition')
  transition(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: TransitionDto) {
    return this.service.transition({
      id,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      status: dto.status,
      invoiceNo: dto.invoiceNo,
      invoiceUrl: dto.invoiceUrl,
      rejectReason: dto.rejectReason,
    });
  }
}
