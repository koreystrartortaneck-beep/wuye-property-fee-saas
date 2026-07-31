import { Body, Controller, Get, Injectable, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
import { ErrorCode, METER_TYPES, MeterType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

class CreateReadingDto {
  @IsString()
  @IsNotEmpty()
  houseId!: string;

  @IsIn(METER_TYPES as unknown as string[])
  meterType!: MeterType;

  @Matches(/^\d{4}-\d{2}$/, { message: 'period 格式须为 YYYY-MM' })
  period!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  value!: number;
}

class ListReadingsQuery {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  @Matches(/^\d{4}-\d{2}$/)
  period!: string;

  @IsOptional()
  @IsIn(METER_TYPES as unknown as string[])
  meterType?: MeterType;
}

@Injectable()
export class MeterService {
  constructor(private readonly prisma: PrismaService) {}

  /** 录入抄表：取上期读数作 prevValue 快照，回退拒绝；同期重复录入为覆盖 */
  async createReading(dto: CreateReadingDto, adminId: string) {
    const prev = await this.prisma.t.meterReading.findFirst({
      where: { houseId: dto.houseId, meterType: dto.meterType, period: { lt: dto.period } },
      orderBy: { period: 'desc' },
    });
    if (prev && dto.value < Number(prev.value)) {
      throw new BizException(
        ErrorCode.METER_READING_BACKWARD,
        `上期(${prev.period})读数 ${prev.value}`,
      );
    }
    return this.prisma.t.meterReading.upsert({
      where: {
        houseId_meterType_period: { houseId: dto.houseId, meterType: dto.meterType, period: dto.period },
      },
      create: {
        houseId: dto.houseId,
        meterType: dto.meterType,
        period: dto.period,
        value: dto.value,
        prevValue: prev ? prev.value : null,
        createdBy: adminId,
      } as never,
      update: { value: dto.value, createdBy: adminId },
    });
  }

  /**
   * 出账用：本期读数差。无本期读数、或缺上期读数时返回 null（跳过出账）。
   *
   * 为什么缺上期读数必须返回 null 而不是按 0 计：
   * 原实现 `prevValue === null ? 0` 会把**累计读数**当成本期用量。小区上线首月，
   * 水表已经用了多年（比如读数 1234），单价 3.5 元/吨时会开出
   *   Math.round(350 × 123400 / 100) = 431900 分 = ¥4319.00
   * 而该户当月实际用水约 30 吨、应为 ¥105.00 —— 单户超收 ¥4214，且全小区首月
   * 同时中招。这不是边界情况，是新小区上线的必然路径。
   *
   * 返回 null 后 calcOne 会以 METER_READING_MISSING 跳过该户并计入 skippedDetail，
   * 物业能在出账页看到「缺读数」而不是收到一张天文数字的账单。
   * 首期基准读数需要先录一期作为基期，第二期起才产生用量。
   */
  async getDiff(houseId: string, meterType: MeterType, period: string): Promise<number | null> {
    const reading = await this.prisma.t.meterReading.findUnique({
      where: { houseId_meterType_period: { houseId, meterType, period } },
    });
    if (!reading) return null;
    if (reading.prevValue === null) return null;
    return Number(reading.value) - Number(reading.prevValue);
  }

  /** 后台查询：某小区某期的抄表情况 + 未录房屋列表 */
  async list(q: ListReadingsQuery) {
    const houses = await this.prisma.t.house.findMany({
      where: { communityId: q.communityId, status: 'ACTIVE' },
      select: { id: true, code: true, displayName: true },
    });
    const readings = await this.prisma.t.meterReading.findMany({
      where: {
        period: q.period,
        houseId: { in: houses.map((h) => h.id) },
        ...(q.meterType ? { meterType: q.meterType } : {}),
      },
    });
    const readHouseIds = new Set(readings.map((r) => r.houseId));
    return {
      readings,
      missing: houses.filter((h) => !readHouseIds.has(h.id)),
    };
  }
}

@Controller('admin/meter-readings')
@UseGuards(AdminGuard, RolesGuard)
export class MeterController {
  constructor(private readonly service: MeterService) {}

  @Post()
  create(@Current() cur: CurrentAdmin, @Body() dto: CreateReadingDto) {
    return this.service.createReading(dto, cur.adminId);
  }

  @Get()
  list(@Query() q: ListReadingsQuery) {
    return this.service.list(q);
  }
}
