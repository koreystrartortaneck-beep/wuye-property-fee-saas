import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ErrorCode, WORK_CATEGORIES, WorkCategory } from '@pf/shared';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';
import { signUploadPaths } from '../upload/upload-access';

class ListQuery extends PageQuery {
  @IsString()
  @IsNotEmpty()
  houseId!: string;

  @IsOptional()
  @IsIn(WORK_CATEGORIES as unknown as string[])
  category?: WorkCategory;
}

/** 业主端工作照片墙：按当前房屋所在小区展示物业工作照片 */
@Controller('owner/work-logs')
@UseGuards(OwnerGuard)
export class OwnerWorkLogsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  @Get()
  async list(@Current() cur: CurrentOwner, @Query() q: ListQuery) {
    await this.houses.assertOwnerHouse(cur.ownerId, q.houseId);
    const house = await this.prisma.raw.house.findUnique({ where: { id: q.houseId } });
    const where = {
      communityId: house!.communityId,
      ...(q.category ? { category: q.category } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.raw.workLog.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.raw.workLog.count({ where }),
    ]);
    /*
     * 图片地址读取时现签：存库的是裸路径，签名只有 10 分钟有效——
     * 把带签名的地址存进库，10 分钟后所有历史图片全部打不开。
     */
    return pageResult(
      list.map((w) => ({ ...w, images: signUploadPaths(w.images) })),
      total,
      q,
    );
  }

  @Get(':id')
  async detail(@Current() cur: CurrentOwner, @Param('id') id: string) {
    const log = await this.prisma.raw.workLog.findUnique({ where: { id } });
    if (!log) throw new BizException(ErrorCode.NOT_FOUND);
    // 归属校验：本人须有该租户下的 ACTIVE 绑定
    const binding = await this.prisma.raw.houseBinding.findFirst({
      where: { wxUserId: cur.ownerId, tenantId: log.tenantId, status: 'ACTIVE' },
    });
    if (!binding) throw new BizException(ErrorCode.NO_BINDING);
    // 列表签了、详情忘了签 —— 结果是列表封面能显示、点进详情全部裂图。
    // 凡是把 images 交给前端的出口都必须现签，漏一个就是一处坏掉的页面。
    return { ...log, images: signUploadPaths(log.images) };
  }
}
