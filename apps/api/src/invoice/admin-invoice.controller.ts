import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
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
  invoiceNo?: string;

  @IsOptional()
  @IsString()
  invoiceUrl?: string;

  @IsOptional()
  @IsString()
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
      this.prisma.t.invoiceApplication.findMany({ where, ...pageArgs(q), orderBy: { appliedAt: 'desc' } }),
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
