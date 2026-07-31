import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { BINDING_STATUSES, BindingStatus, ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class ListBindingsQuery extends PageQuery {
  @IsOptional()
  @IsIn(BINDING_STATUSES as unknown as string[])
  status?: BindingStatus;
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
  constructor(private readonly prisma: PrismaService) {}

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

  async review(id: string, adminId: string, dto: ReviewDto) {
    const binding = await this.prisma.t.houseBinding.findUnique({ where: { id } });
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

  @Post(':id/review')
  review(@Param('id') id: string, @Current() cur: CurrentAdmin, @Body() dto: ReviewDto) {
    return this.service.review(id, cur.adminId, dto);
  }
}
