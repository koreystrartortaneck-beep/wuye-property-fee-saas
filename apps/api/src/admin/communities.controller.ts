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
    /*
     * 审计记录必须算进来，而且必须排在最后 —— 它是最常见、也最不好懂的那一条。
     *
     * 我先做错过一次：试图在删小区时把审计行的 communityId 摘成 null，
     * 结果撞上 AuditLog 的 BEFORE UPDATE 触发器
     * （SIGNAL 45000 'AuditLog is append-only: UPDATE is forbidden'），
     * 于是删小区从「拒绝并说明原因」变成了「50000 服务器内部错误」—— 更糟。
     *
     * 那个触发器不是障碍，是设计：审计不可改、不可删，被审计引用的父记录
     * 也不可动（迁移里写着 "Parent keys are immutable once referenced by an
     * audit row"）。也就是说 —— **一个有过历史的小区，本来就不该能被删掉**。
     *
     * 所以正确的做法不是绕开它，而是让预检如实说出来：
     * 原先它不在清单里，预检全绿、界面显示可以删，数据库在最后一步拒绝。
     */
    ['auditLog', '审计记录'],
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
      /*
       * 审计记录要单独交代一句。其余几项物业能自己去清，
       * 而审计是**永远清不掉的**（按设计），只说「请先清理」等于让人做一件做不到的事。
       */
      const hasAudit = attached.some((a) => a.startsWith('审计记录'));
      throw new BizException(
        ErrorCode.VALIDATION,
        `「${community.name}」下还有 ${attached.join('、')}，不能删除。` +
          (hasAudit
            ? '审计记录按规定不可删除，因此这个小区无法再删除——请改为「停用」，停用后业主端不再显示它。'
            : '请先转移或清理这些数据，或改为停用该小区。'),
      );
    }

    await this.prisma.t.community.delete({ where: { id } });
    /*
     * 删小区补审计（原来完全没有）。
     * 能走到这里说明该小区从未产生过任何审计 —— 见上面 auditLog 那条挂载校验。
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
      afterSummary: { event: 'COMMUNITY_DELETE' },
    });
    return { deleted: true, name: community.name };
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
