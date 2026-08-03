import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { BINDING_RELATIONS, BindingRelation, ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BindingSyncService } from '../binding/binding-sync.service';
import { Current, CurrentOwner } from '../auth/current.decorator';
import { OwnerGuard } from '../auth/owner.guard';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

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
 * 房号分词。
 *
 * 业主打房号时，分隔符用不用、用哪个、量词写不写，全是随意的：
 * 「1栋101」「1-101」「1 101」「101室」指的都是同一套房，
 * 而库里存的是 code=「1-1-101」、displayName=「1栋1单元101」。
 * 想让整串匹配同时容纳这些写法是不可能的 —— 拆成词逐个 AND 才行。
 *
 * 量词的先后顺序无关：正则从左往右按位置扫，在「单」那一位上「元」匹配不上，
 * 所以 单元 一定先于 元 被命中。（这一点我一开始想错了，还为它写了条守卫，
 * 交换顺序后测试纹丝不动 —— 才发现前提是假的。）
 * 真正要紧的是**别漏**：少一个量词，含它的写法就整串切不开，
 * 只剩一段 → 不触发回退 → 0 条。下面的分词用例逐条钉住这件事。
 */
const HOUSE_SPLIT = /[\s\-–—_/／#,，.。、]+|单元|号楼|栋|幢|座|室|号|楼|层/g;

/** 最多取 5 段：再多是 AND 越加越窄，且多半是误输入 */
export function tokenize(keyword: string): string[] {
  return keyword
    .split(HOUSE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

/** 整串子串匹配：精确输入应当得到精确结果 */
function matchWhole(keyword: string) {
  return { OR: [{ code: { contains: keyword } }, { displayName: { contains: keyword } }] };
}

/**
 * 业主端房屋服务。业主天然跨租户 → 使用 raw client，
 * 一切访问经 ACTIVE 绑定校验（spec §6.2）。
 */
@Injectable()
export class OwnerHousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bindingSync: BindingSyncService,
    private readonly audit: AuditService,
  ) {}

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

  /*
   * 这两个查询都必须回传 total。
   *
   * 原来它们只返回一个数组，上限分别写死 50 / 100 —— 是**静默截断**：
   * 一个 213 户的小区，业主端拿到按 code 排序的前 100 条，
   * 后一百多户的业主翻遍整个列表都找不到自己家，而界面上没有任何异样，
   * 他只会得出「我家没登记」的结论。
   *
   * 截断本身不可避免（不能把 213 条全推给手机），
   * 可避免的是**不说**。有了 total，业主端才能说「共 213 套，请输入房号缩小范围」。
   */
  private static readonly PAGE_SIZE = 20;

  async searchCommunities(keyword?: string) {
    const where = {
      status: 'ACTIVE' as const,
      ...(keyword ? { name: { contains: keyword } } : {}),
      tenant: { status: 'ACTIVE' as const },
    };
    const [list, total] = await Promise.all([
      this.prisma.raw.community.findMany({
        where,
        include: { tenant: { select: { name: true, bindingConfig: { select: { phoneMatch: true, selfApply: true } } } } },
        take: OwnerHousesService.PAGE_SIZE,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.raw.community.count({ where }),
    ]);
    return {
      items: list.map((c) => ({
        id: c.id,
        name: c.name,
        address: c.address,
        tenantName: c.tenant.name,
        /*
         * 渠道开关随小区下发,小程序按它显隐两条绑定路径。
         * 缺配置行 = 全默认(全开)。UI 只是跟着显隐 —— 真正的强制在服务端:
         * phoneMatch 在 bindPhone 的匹配查询里过滤,selfApply 在 applyBinding 里拒绝。
         */
        binding: {
          phoneMatch: c.tenant.bindingConfig?.phoneMatch ?? true,
          selfApply: c.tenant.bindingConfig?.selfApply ?? true,
        },
      })),
      total,
    };
  }

  /** 供申请绑定选择房号：只暴露 code/displayName */
  async listHouses(communityId: string, building?: string, keyword?: string) {
    const base = {
      communityId,
      status: 'ACTIVE' as const,
      ...(building ? { building } : {}),
    };
    const kw = keyword?.trim();
    const run = (extra: object) => {
      const where = { ...base, ...extra };
      return Promise.all([
        this.prisma.raw.house.findMany({
          where,
          select: { id: true, code: true, displayName: true, type: true, building: true },
          take: OwnerHousesService.PAGE_SIZE,
          orderBy: { code: 'asc' },
        }),
        this.prisma.raw.house.count({ where }),
      ]);
    };

    if (!kw) {
      const [items, total] = await run({});
      return { items, total };
    }

    // 先按原样整串匹配。精确输入（1-101、8-2）应当得到精确结果，不该被拆词冲淡
    let [items, total] = await run(matchWhole(kw));
    if (total === 0) {
      /*
       * 整串匹配不中时才拆词。
       *
       * 起因：业主打「1栋101」得到 0 条 —— 而那套房就在库里，
       * 只是存成「1栋1单元101」，中间隔着「1单元」。
       * 实测三种最自然的输入全部返回 0：「1栋101」「1 101」「101室」。
       *
       * 而在这个界面上，0 条的含义是「物业没登记我家」。
       * 业主不会想到是自己的写法和库里的格式对不上 ——
       * 他会去找物业，物业在后台一搜就有。又是一次把
       * 「我没找到」显示成「没有」。
       *
       * 拆词放在**后面**而不是一开始：拆完是 AND 匹配，
       * 「8-2」拆成 8 和 2 会把 2 单元的房子也捞进来，
       * 而整串「8-2」本来就能精确命中 8 栋 2 单元。
       * 先精确、不中再放宽，两种输入都照顾到。
       */
      const tokens = tokenize(kw);
      if (tokens.length > 1) {
        [items, total] = await run({
          AND: tokens.map((t) => ({ OR: [{ code: { contains: t } }, { displayName: { contains: t } }] })),
        });
      }
    }
    return { items, total };
  }

  async applyBinding(ownerId: string, dto: ApplyBindingDto) {
    const house = await this.prisma.raw.house.findUnique({ where: { id: dto.houseId } });
    if (!house || house.status !== 'ACTIVE') throw new BizException(ErrorCode.NOT_FOUND);

    /*
     * 渠道门(服务端强制,UI 显隐只是提示):
     * selfApply 关掉的物业公司不接受自助申请。绕过小程序直接调接口的也一样被拒。
     */
    const config = await this.bindingSync.getConfig(house.tenantId);
    if (!config.selfApply) {
      throw new BizException(ErrorCode.VALIDATION, '该小区未开放自助申请，请联系物业登记您的手机号');
    }
    /*
     * 免审批模式:申请即生效。
     * 与人工审批走同一条 grantContact 路径 —— 用户有手机号就自动进授权名单,
     * 从此删号即解绑;区别只在没有审核人,审计事件标 BINDING_AUTO_APPROVE。
     */
    const autoApprove = !config.selfApplyNeedsApproval;
    const initialStatus = autoApprove ? ('ACTIVE' as const) : ('PENDING' as const);

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
      const updated = await this.prisma.raw.houseBinding.update({
        where: { id: exists.id },
        data: {
          status: initialStatus,
          relation: dto.relation,
          applicantName: dto.applicantName,
          source: 'APPLY',
          rejectReason: null,
          revokedAt: null,
          revokeReason: null,
        },
      });
      if (autoApprove) await this.afterAutoApprove(ownerId, house, updated.id, dto.applicantName);
      return updated;
    }
    try {
      const created = await this.prisma.raw.houseBinding.create({
        data: {
          tenantId: house.tenantId,
          wxUserId: ownerId,
          houseId: dto.houseId,
          relation: dto.relation,
          applicantName: dto.applicantName,
          source: 'APPLY',
          status: initialStatus,
        },
      });
      if (autoApprove) await this.afterAutoApprove(ownerId, house, created.id, dto.applicantName);
      return created;
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

  /** 免审批通过后的收尾:留痕 + 手机号进授权名单(与人工审批同一条路径) */
  private async afterAutoApprove(
    ownerId: string,
    house: { id: string; tenantId: string; communityId: string; code: string },
    bindingId: string,
    applicantName: string,
  ): Promise<void> {
    await runWithTenant(house.tenantId, () =>
      this.audit.append({
        tenantId: house.tenantId,
        communityId: house.communityId,
        actorType: 'WX_USER',
        actorId: ownerId,
        action: 'UPDATE',
        resourceType: 'HouseBinding',
        resourceId: bindingId,
        afterSummary: {
          event: 'BINDING_AUTO_APPROVE',
          status: 'ACTIVE',
          houseCode: house.code,
        },
      }),
    );
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: ownerId }, select: { phone: true } });
    if (user?.phone) {
      await this.prisma.raw.$transaction((tx) =>
        this.bindingSync.grantContact(tx, house, user.phone!, applicantName, 'APPLY_APPROVED', {
          type: 'WX_USER',
          id: ownerId,
        }),
      );
    }
  }

  /** 本人全部绑定（含审核中/已驳回，供「我的」页展示进度） */
  async myBindings(ownerId: string) {
    const bindings = await this.prisma.raw.houseBinding.findMany({
      /*
       * 同样要排除已停用的物业公司。
       *
       * 那些记录对业主毫无价值 —— 他连那个小区都搜不到，「重新申请」点了也没用。
       * 2026-08-02 实测：业主的「我的」页上并排摆着两条「金港城 1栋1单元101」，
       * 一条是废弃租户的历史、一条是真正在走的申请，他完全分不清。
       */
      where: { wxUserId: ownerId, house: { community: { tenant: { status: 'ACTIVE' } } } },
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
