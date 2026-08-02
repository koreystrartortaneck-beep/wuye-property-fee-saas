import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { AuditService } from '../audit/audit.service';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

class CreateCommunityDto {
  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  servicePhone?: string;
}

class UpdateCommunityDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  servicePhone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Injectable()
export class CommunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  create(dto: CreateCommunityDto) {
    /*
     * tenantId 由租户隔离扩展自动写入，所以类型上要 Omit 掉它 ——
     * 但**不能**因此把整个 data 转成 never：那会连带关掉其余所有字段的校验，
     * 字段名写错、类型不符都要等到运行时才炸。写操作出错就是数据错。
     *
     * 用 Unchecked 版：扩展注入的是标量 tenantId，而 CommunityCreateInput 因为有
     * tenant 关联字段，要求的是 { tenant: { connect } } 形状。
     */
    const data: Omit<Prisma.CommunityUncheckedCreateInput, 'tenantId'> = { ...dto };
    return this.prisma.t.community.create({ data: data as Prisma.CommunityUncheckedCreateInput });
  }

  async list(q: PageQuery) {
    const [list, total] = await Promise.all([
      this.prisma.t.community.findMany({ ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.community.count(),
    ]);
    return pageResult(list, total, q);
  }

  update(id: string, dto: UpdateCommunityDto) {
    return this.prisma.t.community.update({ where: { id }, data: dto });
  }

  /*
   * 删除前必须清点的**业务数据**。任何一项非空就拒绝，并在提示里说清挂了什么 ——
   * 只说「无法删除」等于让人去猜。
   *
   * 刻意不包含留痕与运维类的表（AuditLog / OperationalAlert / Incident /
   * IdempotencyRecord / OutboxEvent / PaymentEvent / Reconciliation* / RefundAttempt）：
   * 审计日志按合规不能删，而它引用一个已删小区是可以接受的 ——
   * 日志本身带着当时的摘要，追溯不依赖小区仍然存在。
   * 若把审计日志也算作阻止项，任何被操作过的小区都永远删不掉，这个接口就没有意义了。
   */
  private static readonly BLOCKING: Array<[string, string]> = [
    ['house', '房屋'],
    ['bill', '账单'],
    ['billBatch', '出账批次'],
    ['feeRule', '收费规则'],
    ['payment', '缴费记录'],
    ['refund', '退款'],
    ['ticket', '工单'],
    ['visitorPass', '访客通行码'],
    ['workLog', '物业公示'],
    ['announcement', '公告'],
    ['coupon', '卡券'],
    ['serviceItem', '生活服务'],
    ['serviceOrder', '服务预约'],
    ['invoiceApplication', '发票申请'],
    ['communityCollectionPolicy', '收款策略'],
  ];

  /**
   * 删除空小区。
   *
   * 存在的理由：历史遗留的测试小区（比如名字里写着「勿用/待删」的）会一直出现在
   * 首页的「各小区收缴情况」表里 —— 而那张表刻意「没有账单也显示 0 而不是隐藏」
   * （隐藏会让物业以为漏了小区）。所以清理只能靠真的删掉。
   *
   * 停用（status=DISABLED）不够：停用后它不再参与出账、业主端也看不到，
   * 但仍留在那张表里。
   */
  async remove(id: string, adminId: string) {
    const community = await this.prisma.t.community.findFirst({
      where: { id },
      select: { id: true, name: true, tenantId: true },
    });
    if (!community) throw new BizException(ErrorCode.NOT_FOUND, '小区不存在或不属于当前物业公司');

    const client = this.prisma.t as unknown as Record<string, { count(args: unknown): Promise<number> }>;
    const attached: string[] = [];
    for (const [model, label] of CommunitiesService.BLOCKING) {
      const n = await client[model].count({ where: { communityId: id } });
      if (n > 0) attached.push(`${label} ${n} 条`);
    }
    if (attached.length > 0) {
      throw new BizException(
        ErrorCode.VALIDATION,
        `「${community.name}」下还有 ${attached.join('、')}，不能删除。请先转移或清理这些数据，或改为停用该小区。`,
      );
    }

    /*
     * 审计行必须先摘钩，否则小区永远删不掉。
     *
     * AuditLog 有一条指向 Community 的外键（..._restrict_fkey）。
     * 而任何一次对该小区的后台操作 —— 包括「删掉它下面的房屋」这个
     * 删小区的**前置步骤** —— 都会写下一条带 communityId 的审计。
     * 于是上面那圈挂载清点全部为 0、界面显示可以删，
     * 数据库却在最后一步拒绝，还回一句「关联的数据不存在或已被删除」——
     * 正好说反了：不是不存在，是还有人指着它。
     *
     * 库里那个「【勿用】审计测试遗留-待删」删不掉，就是这么来的。
     *
     * 不能删审计行：那是历史，删除一个小区不该抹掉它发生过什么。
     * communityId 本来就是可空的，摘成 null 即可 ——
     * tenantId、动作、资源、摘要全部原样保留，只是不再挂在一个已消失的小区上。
     */
    const detached = await this.prisma.raw.$transaction(async (tx) => {
      const r = await tx.auditLog.updateMany({ where: { tenantId: community.tenantId, communityId: id }, data: { communityId: null } });
      await tx.community.delete({ where: { id } });
      return r.count;
    });

    /*
     * 删小区原来完全没有审计。
     * 摘钩之后更需要它：那些历史审计行不再指向任何小区，
     * 「这个小区去哪了」只剩这一条记录能回答。
     */
    await this.audit.append({
      tenantId: community.tenantId,
      communityId: null,
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'DELETE',
      resourceType: 'Community',
      resourceId: id,
      beforeSummary: { name: community.name },
      afterSummary: { event: 'COMMUNITY_DELETE', detachedAuditLogs: detached },
    });
    return { deleted: true, name: community.name, detachedAuditLogs: detached };
  }
}

@Controller('admin/communities')
@UseGuards(AdminGuard, RolesGuard)
export class CommunitiesController {
  constructor(private readonly service: CommunitiesService) {}

  @Post()
  create(@Body() dto: CreateCommunityDto) {
    return this.service.create(dto);
  }

  @Get()
  list(@Query() q: PageQuery) {
    return this.service.list(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCommunityDto) {
    return this.service.update(id, dto);
  }

  /*
   * 删除限 TENANT_ADMIN：STAFF 的日常是抄表、处理工单，没有删小区的理由，
   * 而误删的代价（哪怕有空校验兜着）不该由一个日常角色承担。
   */
  @Roles('TENANT_ADMIN')
  @Delete(':id')
  remove(@Current() cur: CurrentAdmin, @Param('id') id: string) {
    return this.service.remove(id, cur.adminId);
  }
}
