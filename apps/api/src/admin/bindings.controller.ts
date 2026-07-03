import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
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
    return this.prisma.t.houseBinding.update({
      where: { id },
      data: {
        status: dto.approve ? 'ACTIVE' : 'REJECTED',
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectReason: dto.approve ? null : dto.rejectReason ?? '未通过审核',
      },
    });
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
