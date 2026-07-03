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

  /** 出账用：本期读数差；无本期读数返回 null */
  async getDiff(houseId: string, meterType: MeterType, period: string): Promise<number | null> {
    const reading = await this.prisma.t.meterReading.findUnique({
      where: { houseId_meterType_period: { houseId, meterType, period } },
    });
    if (!reading) return null;
    const prev = reading.prevValue === null ? 0 : Number(reading.prevValue);
    return Number(reading.value) - prev;
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
