import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { BizException } from '../common/biz.exception';
import { OwnerHousesService } from '../owner/owner-houses.controller';
import { PrismaService } from '../prisma/prisma.service';

/** 业主端公告：按当前房屋所在小区可见（含公司全员公告） */
@Controller('owner/announcements')
@UseGuards(OwnerGuard)
export class OwnerAnnouncementsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly houses: OwnerHousesService,
  ) {}

  @Get()
  async list(@Current() cur: CurrentOwner, @Query('houseId') houseId: string) {
    if (!houseId) throw new BizException(ErrorCode.VALIDATION, '缺少 houseId');
    await this.houses.assertOwnerHouse(cur.ownerId, houseId);
    const house = await this.prisma.raw.house.findUnique({ where: { id: houseId } });
    return this.prisma.raw.announcement.findMany({
      where: {
        tenantId: house!.tenantId,
        status: 'PUBLISHED',
        OR: [{ communityId: house!.communityId }, { communityId: null }],
      },
      orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
      take: 50,
      select: { id: true, title: true, content: true, pinned: true, publishedAt: true },
    });
  }

  @Get(':id')
  async detail(@Current() cur: CurrentOwner, @Param('id') id: string) {
    const a = await this.prisma.raw.announcement.findUnique({ where: { id } });
    if (!a || a.status !== 'PUBLISHED') throw new BizException(ErrorCode.NOT_FOUND);
    // 归属校验：本人须有该租户下的 ACTIVE 绑定
    const binding = await this.prisma.raw.houseBinding.findFirst({
      where: { wxUserId: cur.ownerId, tenantId: a.tenantId, status: 'ACTIVE' },
    });
    if (!binding) throw new BizException(ErrorCode.NO_BINDING);
    return a;
  }
}
