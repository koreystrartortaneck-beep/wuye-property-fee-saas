import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HOUSE_TYPES, HouseType, RULE_PERIODS, RULE_TYPES, RulePeriod, RuleType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { validateRuleParams } from './engine/rule-params';

class CreateFeeRuleDto {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(HOUSE_TYPES as unknown as string[])
  houseType!: HouseType;

  @IsIn(RULE_TYPES as unknown as string[])
  ruleType!: RuleType;

  @IsObject()
  params!: Record<string, unknown>;

  @IsIn(RULE_PERIODS as unknown as string[])
  period!: RulePeriod;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  billDay!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  dueDays!: number;
}

class UpdateFeeRuleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  billDay?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  dueDays?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

class ListFeeRulesQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;
}

@Injectable()
export class FeeRulesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateFeeRuleDto) {
    validateRuleParams(dto.ruleType, dto.params);
    return this.prisma.t.feeRule.create({ data: { ...dto, params: dto.params as never } as never });
  }

  async list(q: ListFeeRulesQuery) {
    const where = q.communityId ? { communityId: q.communityId } : {};
    const [list, total] = await Promise.all([
      this.prisma.t.feeRule.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.feeRule.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  async update(id: string, dto: UpdateFeeRuleDto) {
    if (dto.params) {
      const rule = await this.prisma.t.feeRule.findUnique({ where: { id } });
      if (rule) validateRuleParams(rule.ruleType as RuleType, dto.params);
    }
    return this.prisma.t.feeRule.update({
      where: { id },
      data: { ...dto, params: dto.params as never },
    });
  }
}

@Controller('admin/fee-rules')
@UseGuards(AdminGuard, RolesGuard)
export class FeeRulesController {
  constructor(private readonly service: FeeRulesService) {}

  @Post()
  create(@Body() dto: CreateFeeRuleDto) {
    return this.service.create(dto);
  }

  @Get()
  list(@Query() q: ListFeeRulesQuery) {
    return this.service.list(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFeeRuleDto) {
    return this.service.update(id, dto);
  }
}
