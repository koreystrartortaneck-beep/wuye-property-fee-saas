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
import { ErrorCode, HOUSE_TYPES, HouseType, RULE_PERIODS, RULE_TYPES, RulePeriod, RuleType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { validateRuleParams } from './engine/rule-params';

/** 可导入/可转换的目标规则类型（FORMULA 已停用，禁止创建或转换为 FORMULA）。 */
const CONVERTIBLE_RULE_TYPES = RULE_TYPES.filter((t) => t !== 'FORMULA');
const RETIRED = 'RETIRED';

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

class ConvertFeeRuleDto {
  @IsIn(CONVERTIBLE_RULE_TYPES as unknown as string[])
  ruleType!: Exclude<RuleType, 'FORMULA'>;

  @IsObject()
  params!: Record<string, unknown>;
}

class ListFeeRulesQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;
}

function disposition(params: unknown): string | null {
  if (params && typeof params === 'object') {
    const value = (params as Record<string, unknown>).__disposition;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

@Injectable()
export class FeeRulesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateFeeRuleDto) {
    if (dto.ruleType === 'FORMULA') {
      throw new BizException(ErrorCode.FORMULA_INVALID, 'FORMULA 规则已停用，请改用固定/面积/计量/公摊规则或账单导入');
    }
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
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');
    if (rule.ruleType === 'FORMULA') {
      // FORMULA 规则永不可重新启用，也不接受参数编辑，只能转换或退役。
      if (dto.enabled === true) throw new BizException(ErrorCode.FORMULA_INVALID, 'FORMULA 规则不可重新启用');
      if (dto.params !== undefined) throw new BizException(ErrorCode.FORMULA_INVALID, 'FORMULA 规则不可编辑参数，请转换规则');
    }
    if (dto.params) validateRuleParams(rule.ruleType as RuleType, dto.params);
    return this.prisma.t.feeRule.update({
      where: { id },
      data: { ...dto, params: dto.params as never },
    });
  }

  /** 受控转换：将停用的 FORMULA 规则原子改为 FIXED/AREA_PRICE/METER/SHARE。 */
  async convert(id: string, dto: ConvertFeeRuleDto) {
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');
    if (rule.ruleType !== 'FORMULA') throw new BizException(ErrorCode.VALIDATION, '仅 FORMULA 规则可转换');
    validateRuleParams(dto.ruleType, dto.params);
    return this.prisma.t.feeRule.update({
      where: { id },
      data: { ruleType: dto.ruleType, params: dto.params as never, enabled: false },
    });
  }

  /** 退役：永久停用 FORMULA 规则，改由导入承接（不可再启用）。 */
  async retire(id: string) {
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');
    if (rule.ruleType !== 'FORMULA') throw new BizException(ErrorCode.VALIDATION, '仅 FORMULA 规则可退役');
    return this.prisma.t.feeRule.update({
      where: { id },
      data: { enabled: false, params: { ...(rule.params as object), __disposition: RETIRED } as never },
    });
  }

  /** FORMULA 规则处置报告：迁移已强制停用的全部 FORMULA 规则及其处置状态。 */
  async formulaReport() {
    const rules = await this.prisma.t.feeRule.findMany({ where: { ruleType: 'FORMULA' } });
    return rules.map((r) => ({
      id: r.id,
      communityId: r.communityId,
      name: r.name,
      enabled: r.enabled,
      disposition: disposition(r.params) ?? 'PENDING',
    }));
  }

  /** 发布就绪门禁：要求零未处置 FORMULA 规则（未转换且未退役）。 */
  async launchReadiness() {
    const report = await this.formulaReport();
    const unresolved = report.filter((r) => r.disposition !== RETIRED);
    return { ready: unresolved.length === 0, unresolvedFormulaRules: unresolved };
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

  @Get('formula-report')
  formulaReport() {
    return this.service.formulaReport();
  }

  @Get('launch-readiness')
  launchReadiness() {
    return this.service.launchReadiness();
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFeeRuleDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/convert')
  convert(@Param('id') id: string, @Body() dto: ConvertFeeRuleDto) {
    return this.service.convert(id, dto);
  }

  @Post(':id/retire')
  retire(@Param('id') id: string) {
    return this.service.retire(id);
  }
}
