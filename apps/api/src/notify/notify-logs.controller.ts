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

    /*
     * 补上房屋与费用名称。
     *
     * 原先列表只有 billId，物业查「这条催缴发给谁了」得先拿这串 cuid 去账单页反查，
     * 而后台界面上并不显示账单 ID。wxUserId 也不足以定位——同一个人可能绑多套房。
     *
     * NotifyLog.billId 是裸字段、没有到 Bill 的 Prisma 关系（这张表刻意不带外键，
     * 通知日志不应因账单被删而失效），所以不能用 include；改为按当页的 billId 去重后
     * 一次批量查。逐条查是 20 次往返，而这个页面按 pageSize 拉。
     */
    const billIds = [...new Set(list.map((r) => r.billId).filter((x): x is string => !!x))];
    const bills = billIds.length
      ? await this.prisma.t.bill.findMany({
          where: { id: { in: billIds } },
          select: {
            id: true,
            title: true,
            period: true,
            house: { select: { id: true, code: true, displayName: true } },
          },
        })
      : [];
    const billById = new Map(bills.map((b) => [b.id, b]));
    const enriched = list.map((r) => ({ ...r, bill: r.billId ? billById.get(r.billId) ?? null : null }));

    return pageResult(enriched, total, q);
  }
}
