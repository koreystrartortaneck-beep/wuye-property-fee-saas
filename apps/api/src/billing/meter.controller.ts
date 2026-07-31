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
    /*
     * 后一期的读数必须一并校验与刷新，否则乱序补录/修正上期会重复计费。
     *
     * getDiff 用的是「本期 value − 本期 prevValue 快照」。prevValue 只在 create
     * 时按当时的上一期写入一次，之后无人维护。于是：
     *
     *  · 补录中间账期：已有 1 月=100、3 月=300（prevValue=100，用量 200）。
     *    补录 2 月=200 → 它自己 prevValue=100、用量 100；而 3 月的 prevValue 仍是
     *    100、用量仍按 200 算。合计计费 300，而 100→300 的真实用量只有 200，
     *    业主被重复收了 100 个单位。
     *  · 修正上期读数：把 2 月从 200 改成 250，3 月的 prevValue 仍停在旧值，
     *    差额同样落空。而 update 分支原本只改 value，连这一点都没顾。
     *
     * 处理原则：本期读数不得大于后一期读数（否则后一期用量为负）；写入后把后一期的
     * prevValue 同步成本期值。若后一期已经出过账，则拒绝改动——账单已经发给业主，
     * 静默改快照并不能修正已出的账，必须让物业先作废那张账单。
     */
    const next = await this.prisma.t.meterReading.findFirst({
      where: { houseId: dto.houseId, meterType: dto.meterType, period: { gt: dto.period } },
      orderBy: { period: 'asc' },
    });
    if (next) {
      if (dto.value > Number(next.value)) {
        throw new BizException(
          ErrorCode.METER_READING_BACKWARD,
          `本期读数 ${dto.value} 大于后一期(${next.period})的 ${next.value}，请先核对`,
        );
      }
      const billedNext = await this.prisma.t.bill.findFirst({
        where: {
          houseId: dto.houseId,
          period: next.period,
          status: { notIn: ['CANCELED'] },
          rule: { ruleType: 'METER', params: { path: '$.meterType', equals: dto.meterType } },
        },
        select: { id: true, title: true, status: true },
      });
      if (billedNext) {
        throw new BizException(
          ErrorCode.VALIDATION,
          `后一期(${next.period})的「${billedNext.title}」已出账，改动本期读数会让该账单的用量算错。` +
            '请先作废那张账单，再修改读数。',
        );
      }
    }

    const saved = await this.prisma.t.meterReading.upsert({
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

    // 后一期的上期快照跟着本期走，用量才不会重复或缺失
    if (next) {
      await this.prisma.t.meterReading.update({
        where: { id: next.id },
        data: { prevValue: saved.value },
      });
    }
    return saved;
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
