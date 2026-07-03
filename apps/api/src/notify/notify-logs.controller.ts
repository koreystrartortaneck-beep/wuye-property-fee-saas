import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { NOTIFY_TYPES, NotifyType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class ListNotifyLogsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  billId?: string;

  @IsOptional()
  @IsIn(NOTIFY_TYPES as unknown as string[])
  type?: NotifyType;
}

@Controller('admin/notify-logs')
@UseGuards(AdminGuard, RolesGuard)
export class NotifyLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() q: ListNotifyLogsQuery) {
    const where = {
      ...(q.billId ? { billId: q.billId } : {}),
      ...(q.type ? { type: q.type } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.notifyLog.findMany({ where, ...pageArgs(q), orderBy: { sentAt: 'desc' } }),
      this.prisma.t.notifyLog.count({ where }),
    ]);
    return pageResult(list, total, q);
  }
}
