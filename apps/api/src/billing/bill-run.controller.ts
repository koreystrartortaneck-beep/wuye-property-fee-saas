import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { BILL_BATCH_STATUSES, BILL_STATUSES, BillBatchStatus, BillStatus } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { BillRunService } from './bill-run.service';
import { BillWorkflowService } from './bill-workflow.service';

class TriggerRunDto {
  @IsString()
  @IsNotEmpty()
  ruleId!: string;

  @Matches(/^\d{4}(-\d{2}|-Q[1-4])?$/, { message: 'period 格式须为 YYYY-MM / YYYY-Qn / YYYY' })
  period!: string;
}

class CancelBillDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

class ReissueBillDto extends CancelBillDto {}

class PublishBatchDto {
  @IsString()
  @IsNotEmpty()
  requestId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

class ListBillsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsString()
  houseId?: string;

  @IsOptional()
  @IsString()
  period?: string;

  @IsOptional()
  @IsString()
  batchId?: string;

  @IsOptional()
  @IsIn(BILL_STATUSES as unknown as string[])
  status?: BillStatus;
}

class ListBatchesQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsString()
  period?: string;

  @IsOptional()
  @IsIn(BILL_BATCH_STATUSES as unknown as string[])
  status?: BillBatchStatus;
}

@Injectable()
export class BillsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListBillsQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.houseId ? { houseId: q.houseId } : {}),
      ...(q.period ? { period: q.period } : {}),
      ...(q.batchId ? { batchId: q.batchId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.bill.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        include: { house: { select: { code: true, displayName: true } } },
      }),
      this.prisma.t.bill.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  async listBatches(q: ListBatchesQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.period ? { period: q.period } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.billBatch.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.billBatch.count({ where }),
    ]);
    return pageResult(list, total, q);
  }
}

@Controller('admin')
@UseGuards(AdminGuard, RolesGuard)
export class BillRunController {
  constructor(
    private readonly billRun: BillRunService,
    private readonly workflow: BillWorkflowService,
    private readonly bills: BillsAdminService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('bill-runs')
  trigger(@Body() dto: TriggerRunDto) {
    return this.billRun.generate(dto.ruleId, dto.period);
  }

  @Get('bill-runs')
  async listRuns(@Query() q: PageQuery) {
    const [list, total] = await Promise.all([
      this.prisma.t.billRun.findMany({
        ...pageArgs(q),
        orderBy: { startedAt: 'desc' },
        include: { rule: { select: { name: true, ruleType: true, communityId: true } } },
      }),
      this.prisma.t.billRun.count(),
    ]);
    return pageResult(list, total, q);
  }

  @Get('bill-batches')
  listBatches(@Query() q: ListBatchesQuery) {
    return this.bills.listBatches(q);
  }

  @Post('bill-batches/:id/publish')
  publishBatch(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: PublishBatchDto) {
    return this.workflow.publishBatch({
      batchId: id,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      requestId: dto.requestId,
      reason: dto.reason ?? null,
    });
  }

  @Get('bills')
  listBills(@Query() q: ListBillsQuery) {
    return this.bills.list(q);
  }

  @Post('bills/:id/cancel')
  cancel(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: CancelBillDto) {
    return this.workflow.cancelBill({
      billId: id,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      reason: dto.reason,
      requestId: dto.requestId,
    });
  }

  @Post('bills/:id/reissue')
  reissue(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: ReissueBillDto) {
    return this.workflow.reissueBill({
      billId: id,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      reason: dto.reason,
      requestId: dto.requestId,
    });
  }
}
