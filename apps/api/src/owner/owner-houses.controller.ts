import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
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
  @MaxLength(100)
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
    // 缺 houseId 时必须显式报参数错误：否则 Prisma 复合唯一键收到 undefined 会抛出，
    // 被兜底成 500「服务器内部错误」，掩盖真实原因（缺参）。
    if (typeof houseId !== 'string' || !houseId) {
      throw new BizException(ErrorCode.VALIDATION, '缺少房屋参数');
    }
    const binding = await this.prisma.raw.houseBinding.findUnique({
      where: { wxUserId_houseId: { wxUserId: ownerId, houseId } },
      include: { house: { select: { community: { select: { tenant: { select: { status: true } } } } } } },
    });
    if (!binding || binding.status !== 'ACTIVE') {
      throw new BizException(ErrorCode.NO_BINDING);
    }
    /*
     * 物业公司被停用后，它的业主必须立刻失去访问权。
     *
     * 2026-08-02 实测发现：一个 status=DISABLED 的租户，它的业主端**完全不受影响**——
     * 照样看得到账单、照样能缴费，钱照样进那家公司的商户号。停用等于没停。
     *
     * 这是这条校验唯一的收口点（账单、支付、工单、访客都经过它），
     * 而它原来只看绑定状态、不看租户状态。
     * 同一个判断 searchCommunities 里其实早就有了（tenant: { status: 'ACTIVE' }）——
     * 有人想到过这件事，但只做了「不能申请绑定到停用公司」那一半，
     * 漏了「已经绑着的怎么办」。
     *
     * 用单独的提示而不是笼统的 NO_BINDING：业主没做错任何事，
     * 让他知道是物业侧的状态，才不会反复去点绑定。
     */
    if (binding.house?.community?.tenant?.status !== 'ACTIVE') {
      throw new BizException(ErrorCode.TENANT_DISABLED);
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
      /*
       * 被拒或被解除之后可以重新申请。
       *
       * 三个「上一轮的结论」都必须清掉，只清 rejectReason 是不够的：
       * revokedAt 决定业主端显示「已解除」还是「申请未通过」，
       * 留着它的话，这次申请若被驳回，首页会错误地说「房屋绑定已解除」——
       * 而他这次根本没绑上过。
       */
      return this.prisma.raw.houseBinding.update({
        where: { id: exists.id },
        data: {
          status: 'PENDING',
          relation: dto.relation,
          applicantName: dto.applicantName,
          source: 'APPLY',
          rejectReason: null,
          revokedAt: null,
          revokeReason: null,
        },
      });
    }
    try {
      return await this.prisma.raw.houseBinding.create({
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
    } catch (e) {
      /*
       * 唯一约束 (wxUserId, houseId) 已经保证不会真重复，所以这里不是补漏洞，
       * 而是把错误说清楚：双击「提交申请」时并发的那一次会撞 P2002，
       * 原本直接抛出去 → 业主看到「服务器内部错误」，会以为没提交成功而反复重试。
       */
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new BizException(ErrorCode.BINDING_EXISTS);
      }
      throw e;
    }
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
      /*
       * 带出 revokedAt：「申请被驳回」和「已生效的绑定被物业解除」在库里都是
       * REJECTED，但对业主意味着完全不同的事，界面必须分开说。
       */
      revokedAt: b.revokedAt,
      revokeReason: b.revokeReason,
      houseId: b.houseId,
      displayName: b.house.displayName,
      communityName: b.house.community.name,
      createdAt: b.createdAt,
    }));
  }

  async myHouses(ownerId: string) {
    const bindings = await this.prisma.raw.houseBinding.findMany({
      /*
       * 必须排除已停用的物业公司。
       * 不排除的话，业主端首页会照常显示那家公司的房屋和待缴金额，
       * 而他点「立即缴纳」时才会被 assertOwnerHouse 挡下 ——
       * 先给希望再拒绝，比一开始就不显示更糟。
       */
      /*
       * HouseBinding 只有 tenantId 标量、没有到 Tenant 的关系，
       * 所以要经 house → community → tenant 走过去。
       */
      where: {
        wxUserId: ownerId,
        status: 'ACTIVE',
        house: { community: { tenant: { status: 'ACTIVE' } } },
      },
      include: {
        house: { include: { community: { select: { name: true, servicePhone: true } } } },
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
      servicePhone: b.house.community.servicePhone,
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
