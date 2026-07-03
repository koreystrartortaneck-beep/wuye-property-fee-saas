import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { BILL_STATUSES, BillStatus, ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { BillRunService } from './bill-run.service';

class TriggerRunDto {
  @IsString()
  @IsNotEmpty()
  ruleId!: string;

  @Matches(/^\d{4}(-\d{2}|-Q[1-4])?$/, { message: 'period 格式须为 YYYY-MM / YYYY-Qn / YYYY' })
  period!: string;
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
  @IsIn(BILL_STATUSES as unknown as string[])
  status?: BillStatus;
}

@Injectable()
export class BillsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListBillsQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.houseId ? { houseId: q.houseId } : {}),
      ...(q.period ? { period: q.period } : {}),
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

  async cancel(id: string) {
    const bill = await this.prisma.t.bill.findUnique({ where: { id } });
    if (!bill) throw new BizException(ErrorCode.NOT_FOUND);
    if (bill.status !== 'UNPAID') {
      throw new BizException(ErrorCode.BILL_NOT_PAYABLE, '仅未缴账单可作废');
    }
    return this.prisma.t.bill.update({ where: { id }, data: { status: 'CANCELED' } });
  }
}

@Controller('admin')
@UseGuards(AdminGuard, RolesGuard)
export class BillRunController {
  constructor(
    private readonly billRun: BillRunService,
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

  @Get('bills')
  listBills(@Query() q: ListBillsQuery) {
    return this.bills.list(q);
  }

  @Post('bills/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.bills.cancel(id);
  }
}
