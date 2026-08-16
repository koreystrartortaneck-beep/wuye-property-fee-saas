import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { COUPON_TYPES, CouponType, ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { AdminGuard } from '../auth/admin.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery } from '../common/pagination';
import { Prisma } from '@prisma/client';
import { assertCommunityInTenant } from '../admin/community-scope';
import { PrismaService } from '../prisma/prisma.service';
import { CouponsService } from './coupons.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class CreateCouponDto {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name!: string;

  @IsIn(COUPON_TYPES as unknown as string[])
  type!: CouponType;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  faceValue?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  threshold?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalQty!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perUserLimit?: number;

  @Matches(DATE)
  validFrom!: string;

  @Matches(DATE)
  validTo!: string;

  /*
   * 自动发放规则(可选;null = 业主自领)。业主**线上缴费成功**时逐条核对,全中即发。
   * 只收白名单字段并逐个校验 —— Json 列不能让调用方塞任意结构进去。
   */
  @IsOptional()
  @IsObject()
  autoGrant?: { minAmount?: number; requireOnTime?: boolean; requireNoArrears?: boolean };
}

class UpdateCouponDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalQty?: number;
}

class ListQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;
}

@Controller('admin')
@UseGuards(AdminGuard, RolesGuard)
export class AdminCouponsController {
  constructor(
    private readonly service: CouponsService,
    private readonly prisma: PrismaService,
  ) {}

  /*
   * 建券/改发行量限管理员(2026-08-16):发券是承诺成本的动作(发行量 × 奖品),
   * 与员工管理同级。核销与查券不限 —— 那是收费员的前台日常。
   */
  @Roles('TENANT_ADMIN')
  @Post('coupons')
  async create(@Body() dto: CreateCouponDto) {
    await assertCommunityInTenant(this.prisma, dto.communityId);
    // 白名单重建 autoGrant:Json 列,绝不透传调用方的原始对象
    let autoGrant: Prisma.InputJsonValue | undefined;
    if (dto.autoGrant) {
      const g = dto.autoGrant;
      if (g.minAmount != null && !(Number(g.minAmount) > 0)) {
        throw new BizException(ErrorCode.VALIDATION, '自动发放的金额门槛要是大于 0 的数');
      }
      autoGrant = {
        ...(g.minAmount != null ? { minAmount: Number(g.minAmount) } : {}),
        ...(g.requireOnTime ? { requireOnTime: true } : {}),
        ...(g.requireNoArrears ? { requireNoArrears: true } : {}),
      };
    }
    const { autoGrant: _raw, ...rest } = dto;
    return this.prisma.t.coupon.create({
      data: {
        ...rest,
        ...(autoGrant !== undefined ? { autoGrant } : {}),
        communityId: dto.communityId || null,
        validFrom: new Date(dto.validFrom),
        validTo: new Date(`${dto.validTo}T23:59:59`),
      } as Omit<Prisma.CouponUncheckedCreateInput, 'tenantId'> as Prisma.CouponUncheckedCreateInput,
    });
  }

  @Get('coupons')
  list(@Query() q: ListQuery) {
    return this.service.adminList(q);
  }

  @Roles('TENANT_ADMIN')
  @Patch('coupons/:id')
  update(@Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.prisma.t.coupon.update({ where: { id }, data: dto });
  }

  @Get('coupons/verify/:code')
  find(@Param('code') code: string) {
    return this.service.findByCode(code);
  }

  @Post('coupons/verify/:code')
  verify(@Param('code') code: string) {
    return this.service.verify(code);
  }
}
