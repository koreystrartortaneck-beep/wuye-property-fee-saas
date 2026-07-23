import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { RECONCILIATION_BILL_TYPES, ReconciliationBillType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from './reconciliation.service';

class TriggerReconcileDto {
  @IsString()
  @IsNotEmpty()
  merchantAccountId!: string;

  @IsString()
  @IsNotEmpty()
  mchid!: string;

  @IsString()
  @IsNotEmpty()
  appid!: string;

  @IsOptional()
  @IsString()
  communityId?: string;

  @Type(() => Date)
  @IsDate()
  businessDate!: Date;

  @IsIn(RECONCILIATION_BILL_TYPES as unknown as string[])
  billType!: ReconciliationBillType;
}

class ResolveItemDto {
  @IsIn(['MANUALLY_CLOSED', 'ESCALATED'])
  status!: 'MANUALLY_CLOSED' | 'ESCALATED';

  @IsOptional()
  @IsString()
  remark?: string;
}

function isoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

@Injectable()
export class AdminReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async listRuns(q: PageQuery) {
    const [list, total] = await Promise.all([
      this.prisma.t.reconciliationRun.findMany({ ...pageArgs(q), orderBy: { startedAt: 'desc' } }),
      this.prisma.t.reconciliationRun.count(),
    ]);
    return pageResult(list, total, q);
  }

  async listItems(runId: string, q: PageQuery) {
    const where = { runId };
    const [list, total] = await Promise.all([
      this.prisma.t.reconciliationItem.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.reconciliationItem.count({ where }),
    ]);
    return pageResult(list, total, q);
  }
}

@Controller('admin/reconciliations')
@UseGuards(AdminGuard, RolesGuard)
export class AdminReconciliationController {
  constructor(
    private readonly service: ReconciliationService,
    private readonly read: AdminReconciliationService,
  ) {}

  @Get()
  listRuns(@Query() q: PageQuery) {
    return this.read.listRuns(q);
  }

  @Get(':runId/items')
  listItems(@Param('runId') runId: string, @Query() q: PageQuery) {
    return this.read.listItems(runId, q);
  }

  @Post()
  trigger(@Current() cur: CurrentAdmin, @Body() dto: TriggerReconcileDto) {
    return this.service.reconcile({
      tenantId: cur.tenantId as string,
      communityId: dto.communityId ?? null,
      merchantAccountId: dto.merchantAccountId,
      mchid: dto.mchid,
      appid: dto.appid,
      businessDate: isoDate(dto.businessDate),
      billType: dto.billType,
      adminId: cur.adminId,
    });
  }

  @Post('items/:itemId/resolve')
  resolve(@Current() cur: CurrentAdmin, @Param('itemId') itemId: string, @Body() dto: ResolveItemDto) {
    return this.service.resolveItem({
      itemId,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      status: dto.status,
      remark: dto.remark,
    });
  }
}
