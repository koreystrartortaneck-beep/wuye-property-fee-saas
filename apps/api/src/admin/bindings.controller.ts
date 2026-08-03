import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { BINDING_STATUSES, BindingStatus, ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { BindingSyncService } from '../binding/binding-sync.service';
import { PrismaService } from '../prisma/prisma.service';

class ListBindingsQuery extends PageQuery {
  @IsOptional()
  @IsIn(BINDING_STATUSES as unknown as string[])
  status?: BindingStatus;
}

class RevokeDto {
  @IsString()
  @MaxLength(191)
  @IsNotEmpty()
  reason!: string;
}

class ReviewDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  rejectReason?: string;
}

@Injectable()
export class BindingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bindingSync: BindingSyncService,
  ) {}

  async list(q: ListBindingsQuery) {
    const where = q.status ? { status: q.status } : {};
    const [list, total] = await Promise.all([
      this.prisma.t.houseBinding.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        include: {
          house: { select: { displayName: true, code: true, communityId: true } },
          wxUser: { select: { phone: true, nickname: true } },
        },
      }),
      this.prisma.t.houseBinding.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  /**
   * 解除一条已生效的绑定。
   *
   * 补的是一个真实缺口：管理端原本只有「列出绑定」和「审核 PENDING 申请」，
   * **没有任何办法解除一条已经生效的绑定**。而租客到期、业主卖房、
   * 当初绑错房号 —— 这些必然会发生，物业却永远解不掉，
   * 那个人会一直能看到这户的账单、一直能替这户缴费。
   *
   * 唯一的替代办法是让业主自己在小程序里点「注销账号」，
   * 但那会连他的身份数据一起匿名化、且不可逆 —— 拿它当解绑用是错的。
   *
   * 状态沿用注销账号的既有约定：REJECTED + revokedAt + revokeReason。
   * 用 revokedAt 与「申请被驳回」区分开 —— 两者对业主意味着完全不同的事，
   * 界面必须分开说（业主端首页据此显示「绑定已解除」而不是「申请未通过」）。
   */
  async revoke(id: string, adminId: string, dto: RevokeDto) {
    // 带出房屋：审计要记小区归属，而 HouseBinding 自己没有 communityId
    const binding = await this.prisma.t.houseBinding.findUnique({
      where: { id },
      include: { house: { select: { communityId: true, code: true, displayName: true } } },
    });
    if (!binding) throw new BizException(ErrorCode.NOT_FOUND);
    if (binding.status !== 'ACTIVE') {
      throw new BizException(ErrorCode.VALIDATION, '仅已生效的绑定可以解除');
    }
    const revokedAt = new Date();
    /*
     * 条件更新，和 review 同一个理由：两名管理员同时操作时，
     * 「后写的静默覆盖前写的」在权限变更上不是排序问题而是越权问题。
     */
    const done = await this.prisma.t.houseBinding.updateMany({
      where: { id, status: 'ACTIVE' },
      data: {
        status: 'REJECTED',
        revokedAt,
        revokeReason: dto.reason,
        reviewedBy: adminId,
        reviewedAt: revokedAt,
      },
    });
    if (done.count !== 1) {
      throw new BizException(ErrorCode.VALIDATION, '该绑定刚刚已被其他人处理，请刷新后查看');
    }
    /*
     * 必须写审计：这是一次**权限撤销** —— 撤销之后那个人再也看不到这户的账单。
     * 注销账号那条路径早就写了（ACCOUNT_DELETE_UNBIND），物业主动解绑不能反而没有。
     */
    await this.audit.append({
      tenantId: binding.tenantId,
      communityId: binding.house?.communityId ?? null,
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'UPDATE',
      resourceType: 'HouseBinding',
      resourceId: id,
      reason: dto.reason,
      beforeSummary: { status: 'ACTIVE' },
      afterSummary: {
        event: 'BINDING_REVOKE',
        status: 'REJECTED',
        houseId: binding.houseId,
        // 房号比 id 有用：查审计的人认得房号，认不得 cuid
        houseCode: binding.house?.code ?? null,
        wxUserId: binding.wxUserId,
      },
    });
    return { ...binding, status: 'REJECTED' as const, revokedAt, revokeReason: dto.reason };
  }

  async review(id: string, adminId: string, dto: ReviewDto) {
    const binding = await this.prisma.t.houseBinding.findUnique({
      where: { id },
      // 房屋带出来:通过时要把申请人手机号写进授权名单,审计要记小区归属
      include: { house: { select: { id: true, tenantId: true, communityId: true, code: true } } },
    });
    if (!binding) throw new BizException(ErrorCode.NOT_FOUND);
    if (binding.status !== 'PENDING') throw new BizException(ErrorCode.VALIDATION, '该申请已处理');
    /*
     * 状态流转用条件更新，不能「查到 PENDING 再无条件 update」。
     *
     * 两名管理员几乎同时点「通过」和「驳回」，两边都能过上面那个 PENDING 检查，
     * 后写的覆盖前写的 —— 而 reviewedBy 记的是后者，被覆盖的那个决定静默消失，
     * 审批记录看起来完全正常。
     *
     * ACTIVE 绑定等于开放该户的账单与缴费权限，所以「驳回被静默改成通过」
     * 不是排序问题而是越权问题。
     *
     * 人工审批证据（reviewedBy/reviewedAt）持久化，后续手机匹配不会覆盖
     * （见 AuthService.bindPhone）。
     */
    const reviewedAt = new Date();
    const done = await this.prisma.t.houseBinding.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: dto.approve ? 'ACTIVE' : 'REJECTED',
        reviewedBy: adminId,
        reviewedAt,
        rejectReason: dto.approve ? null : dto.rejectReason ?? '未通过审核',
      },
    });
    if (done.count !== 1) {
      throw new BizException(ErrorCode.VALIDATION, '该申请刚刚已被其他人处理，请刷新后查看');
    }

    /*
     * 审批必须留痕。此前 revoke 有审计而 review 没有 —— 不对称:
     * 「通过」开放的和「解除」撤销的是同一份权限,凭什么一个记一个不记。
     */
    await this.audit.append({
      tenantId: binding.tenantId,
      communityId: binding.house?.communityId ?? null,
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'UPDATE',
      resourceType: 'HouseBinding',
      resourceId: id,
      reason: dto.approve ? null : dto.rejectReason ?? '未通过审核',
      beforeSummary: { status: 'PENDING' },
      afterSummary: {
        event: 'BINDING_REVIEW',
        status: dto.approve ? 'ACTIVE' : 'REJECTED',
        houseCode: binding.house?.code ?? null,
        wxUserId: binding.wxUserId,
      },
    });

    if (dto.approve && binding.house) {
      /*
       * 通过的那一刻,申请人手机号自动进该房授权名单(单一数据源):
       * 从此归名单管 —— 物业删号即解绑,和其他授权人完全一样。
       * 没有手机号的用户(极少:老版本注册且从未授权)跳过,他的绑定照常生效,
       * 只是换租时物业要在绑定列表里手动解除,而不是删号。
       */
      const user = await this.prisma.raw.wxUser.findUnique({
        where: { id: binding.wxUserId },
        select: { phone: true },
      });
      if (user?.phone) {
        const house = binding.house;
        await this.prisma.raw.$transaction((tx) =>
          this.bindingSync.grantContact(tx, house, user.phone!, binding.applicantName ?? null, 'APPLY_APPROVED', {
            type: 'ADMIN',
            id: adminId,
          }),
        );
      }
    }

    return {
      ...binding,
      status: dto.approve ? ('ACTIVE' as const) : ('REJECTED' as const),
      reviewedBy: adminId,
      reviewedAt,
    };
  }
}

@Controller('admin/bindings')
@UseGuards(AdminGuard, RolesGuard)
export class BindingsController {
  constructor(private readonly service: BindingsService) {}

  @Get()
  list(@Query() q: ListBindingsQuery) {
    return this.service.list(q);
  }

  /*
   * 解除绑定会撤销一个人对该户账单的全部访问权，风险等同退款那一类，
   * 所以限定 TENANT_ADMIN（RolesGuard 的规则是「没标 @Roles 就放行所有管理员」）。
   */
  @Roles('TENANT_ADMIN')
  @Post(':id/revoke')
  revoke(@Current() cur: CurrentAdmin, @Param('id') id: string, @Body() dto: RevokeDto) {
    return this.service.revoke(id, cur.adminId, dto);
  }

  @Post(':id/review')
  review(@Param('id') id: string, @Current() cur: CurrentAdmin, @Body() dto: ReviewDto) {
    return this.service.review(id, cur.adminId, dto);
  }
}
