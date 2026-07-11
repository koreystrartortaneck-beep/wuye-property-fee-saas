import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { COUPON_TYPES, CouponType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery } from '../common/pagination';
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

  @Post('coupons')
  create(@Body() dto: CreateCouponDto) {
    return this.prisma.t.coupon.create({
      data: {
        ...dto,
        communityId: dto.communityId || null,
        validFrom: new Date(dto.validFrom),
        validTo: new Date(`${dto.validTo}T23:59:59`),
      } as never,
    });
  }

  @Get('coupons')
  list(@Query() q: ListQuery) {
    return this.service.adminList(q);
  }

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
