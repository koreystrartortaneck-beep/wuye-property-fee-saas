import { Body, Controller, Get, Injectable, Put, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

class UpsertSharePoolDto {
  @IsString()
  @IsNotEmpty()
  ruleId!: string;

  @Matches(/^\d{4}(-\d{2}|-Q[1-4])?$/, { message: 'period 格式须为 YYYY-MM / YYYY-Qn / YYYY' })
  period!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  totalAmount!: number;
}

@Injectable()
export class SharePoolService {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(dto: UpsertSharePoolDto) {
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id: dto.ruleId } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '规则不存在');
    if (rule.ruleType !== 'SHARE') {
      throw new BizException(ErrorCode.VALIDATION, '仅公摊类规则需要录入总额');
    }
    return this.prisma.t.sharePool.upsert({
      where: { ruleId_period: { ruleId: dto.ruleId, period: dto.period } },
      create: { ruleId: dto.ruleId, period: dto.period, totalAmount: dto.totalAmount } as never,
      update: { totalAmount: dto.totalAmount },
    });
  }

  list(ruleId?: string) {
    return this.prisma.t.sharePool.findMany({
      where: ruleId ? { ruleId } : {},
      orderBy: { period: 'desc' },
      take: 100,
    });
  }
}

@Controller('admin/share-pools')
@UseGuards(AdminGuard, RolesGuard)
export class SharePoolController {
  constructor(private readonly service: SharePoolService) {}

  @Put()
  upsert(@Body() dto: UpsertSharePoolDto) {
    return this.service.upsert(dto);
  }

  @Get()
  list(@Query('ruleId') ruleId?: string) {
    return this.service.list(ruleId);
  }
}
