import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { BINDING_RELATIONS, BindingRelation, ErrorCode } from '@pf/shared';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

class ApplyBindingDto {
  @IsString()
  @IsNotEmpty()
  houseId!: string;

  @IsIn(BINDING_RELATIONS as unknown as string[])
  relation!: BindingRelation;

  @IsString()
  @IsNotEmpty()
  applicantName!: string;
}

/**
 * 业主端房屋服务。业主天然跨租户 → 使用 raw client，
 * 一切访问经 ACTIVE 绑定校验（spec §6.2）。
 */
@Injectable()
export class OwnerHousesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 断言业主对房屋有 ACTIVE 绑定，否则 41001（账单/支付复用） */
  async assertOwnerHouse(ownerId: string, houseId: string): Promise<void> {
    const binding = await this.prisma.raw.houseBinding.findUnique({
      where: { wxUserId_houseId: { wxUserId: ownerId, houseId } },
    });
    if (!binding || binding.status !== 'ACTIVE') {
      throw new BizException(ErrorCode.NO_BINDING);
    }
  }

  async searchCommunities(keyword?: string) {
    const list = await this.prisma.raw.community.findMany({
      where: {
        status: 'ACTIVE',
        ...(keyword ? { name: { contains: keyword } } : {}),
        tenant: { status: 'ACTIVE' },
      },
      include: { tenant: { select: { name: true } } },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    return list.map((c) => ({ id: c.id, name: c.name, address: c.address, tenantName: c.tenant.name }));
  }

  /** 供申请绑定选择房号：只暴露 code/displayName */
  async listHouses(communityId: string, building?: string, keyword?: string) {
    const list = await this.prisma.raw.house.findMany({
      where: {
        communityId,
        status: 'ACTIVE',
        ...(building ? { building } : {}),
        ...(keyword ? { OR: [{ code: { contains: keyword } }, { displayName: { contains: keyword } }] } : {}),
      },
      select: { id: true, code: true, displayName: true, type: true, building: true },
      take: 100,
      orderBy: { code: 'asc' },
    });
    return list;
  }

  async applyBinding(ownerId: string, dto: ApplyBindingDto) {
    const house = await this.prisma.raw.house.findUnique({ where: { id: dto.houseId } });
    if (!house || house.status !== 'ACTIVE') throw new BizException(ErrorCode.NOT_FOUND);

    const exists = await this.prisma.raw.houseBinding.findUnique({
      where: { wxUserId_houseId: { wxUserId: ownerId, houseId: dto.houseId } },
    });
    if (exists && exists.status !== 'REJECTED') {
      throw new BizException(ErrorCode.BINDING_EXISTS);
    }
    if (exists) {
      // 被拒后可重新申请
      return this.prisma.raw.houseBinding.update({
        where: { id: exists.id },
        data: { status: 'PENDING', relation: dto.relation, applicantName: dto.applicantName, source: 'APPLY', rejectReason: null },
      });
    }
    return this.prisma.raw.houseBinding.create({
      data: {
        tenantId: house.tenantId,
        wxUserId: ownerId,
        houseId: dto.houseId,
        relation: dto.relation,
        applicantName: dto.applicantName,
        source: 'APPLY',
        status: 'PENDING',
      },
    });
  }

  /** 本人全部绑定（含审核中/已驳回，供「我的」页展示进度） */
  async myBindings(ownerId: string) {
    const bindings = await this.prisma.raw.houseBinding.findMany({
      where: { wxUserId: ownerId },
      include: { house: { include: { community: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return bindings.map((b) => ({
      id: b.id,
      status: b.status,
      relation: b.relation,
      rejectReason: b.rejectReason,
      houseId: b.houseId,
      displayName: b.house.displayName,
      communityName: b.house.community.name,
      createdAt: b.createdAt,
    }));
  }

  async myHouses(ownerId: string) {
    const bindings = await this.prisma.raw.houseBinding.findMany({
      where: { wxUserId: ownerId, status: 'ACTIVE' },
      include: {
        house: { include: { community: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return bindings.map((b) => ({
      houseId: b.houseId,
      relation: b.relation,
      code: b.house.code,
      displayName: b.house.displayName,
      type: b.house.type,
      area: b.house.area,
      communityId: b.house.communityId,
      communityName: b.house.community.name,
    }));
  }
}

@Controller('owner')
@UseGuards(OwnerGuard)
export class OwnerHousesController {
  constructor(private readonly service: OwnerHousesService) {}

  @Get('communities')
  communities(@Query('keyword') keyword?: string) {
    return this.service.searchCommunities(keyword);
  }

  @Get('communities/:id/houses')
  houses(
    @Param('id') communityId: string,
    @Query('building') building?: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.service.listHouses(communityId, building, keyword);
  }

  @Post('bindings')
  apply(@Current() cur: CurrentOwner, @Body() dto: ApplyBindingDto) {
    return this.service.applyBinding(cur.ownerId, dto);
  }

  @Get('my/houses')
  mine(@Current() cur: CurrentOwner) {
    return this.service.myHouses(cur.ownerId);
  }

  @Get('my/bindings')
  myBindings(@Current() cur: CurrentOwner) {
    return this.service.myBindings(cur.ownerId);
  }
}
