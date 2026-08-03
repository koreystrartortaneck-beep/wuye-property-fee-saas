import { Body, Controller, Delete, Get, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDate, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { assertCommunityInTenant } from '../admin/community-scope';
import { PrismaService } from '../prisma/prisma.service';

/*
 * 房屋 ↔ 收费标准挂接 —— ANNIVERSARY 方案的选房依据。
 *
 * 挂了才出账,不挂 = 不出账(免收/空置就是不挂)。
 * 摘除 = 置 endDate,不硬删:历史账单要能回答「这房去年按哪条标准收的」。
 * 调价改标准那一条,挂着的房屋下次出账全部跟着变 —— 这正是把
 * 「谁 1.2 谁 1.4」做成可配置的意义。
 */

class AttachDto {
  @IsString()
  @IsNotEmpty()
  ruleId!: string;

  /** 首个账期锚点,缺省用房屋的放户日期 */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startDate?: Date;
}

class BulkAttachDto {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  @IsString()
  @IsNotEmpty()
  ruleId!: string;

  @IsArray()
  @ArrayMaxSize(2000, { message: '单次最多挂接 2000 套，请分批' })
  @IsString({ each: true })
  houseIds!: string[];
}

@Injectable()
export class HouseStandardsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForHouse(houseId: string) {
    const house = await this.prisma.t.house.findFirst({
      where: { id: houseId },
      select: { id: true, code: true, displayName: true, handoverDate: true },
    });
    if (!house) throw new BizException(ErrorCode.NOT_FOUND, '房屋不存在或不属于当前物业公司');
    const items = await this.prisma.t.houseStandard.findMany({
      where: { houseId },
      include: { rule: { select: { id: true, name: true, code: true, ruleType: true, params: true, periodScheme: true, rounding: true, enabled: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return { house, items };
  }

  async attach(houseId: string, dto: AttachDto, adminId: string) {
    const house = await this.prisma.t.house.findFirst({ where: { id: houseId }, select: { id: true, communityId: true } });
    if (!house) throw new BizException(ErrorCode.NOT_FOUND, '房屋不存在或不属于当前物业公司');
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id: dto.ruleId } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '收费标准不存在');
    /*
     * 标准必须属于房屋所在小区。挂错小区的标准不会立刻报错(挂接本身能落库),
     * 但出账时按标准扫挂接、批次又按标准的小区建 —— 账单会挂到别的小区名下,
     * 物业在自己小区的列表里永远找不到。在入口就挡住。
     */
    if (rule.communityId !== house.communityId) {
      throw new BizException(ErrorCode.VALIDATION, '该收费标准属于其他小区，不能挂到这套房屋上');
    }

    try {
      const created = await this.prisma.t.houseStandard.create({
        data: {
          houseId,
          ruleId: dto.ruleId,
          startDate: dto.startDate ?? null,
          createdBy: adminId,
        } as Omit<Prisma.HouseStandardUncheckedCreateInput, 'tenantId'> as Prisma.HouseStandardUncheckedCreateInput,
      });
      return created;
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        /*
         * 已有同 (houseId, ruleId) 挂接:若是被摘除的(endDate 已置),恢复它 ——
         * 「重新启用」是真实需求(空置半年又住人了)。
         * 条件更新而不是「查到再改」:两名管理员同时操作时后写覆盖前写,
         * 挂接决定出不出账,静默覆盖等于静默改了收费范围(仓库惯例,守卫在盯)。
         * startDate 只在显式给了才覆盖,否则保留原值。
         */
        const revived = await this.prisma.t.houseStandard.updateMany({
          where: { houseId, ruleId: dto.ruleId },
          data: { status: 'ACTIVE', endDate: null, ...(dto.startDate ? { startDate: dto.startDate } : {}) },
        });
        if (revived.count !== 1) throw e;
        return this.prisma.t.houseStandard.findFirst({ where: { houseId, ruleId: dto.ruleId } });
      }
      throw e;
    }
  }

  /** 摘除:置 endDate(今天),之后的扫描月不再出账;历史账单不动 */
  async detach(houseId: string, ruleId: string) {
    // 条件更新,一步到位:不存在 → count 0 → NOT_FOUND,无读后写竞态
    const done = await this.prisma.t.houseStandard.updateMany({
      where: { houseId, ruleId, status: 'ACTIVE' },
      data: { endDate: new Date(), status: 'DISABLED' },
    });
    if (done.count !== 1) throw new BizException(ErrorCode.NOT_FOUND, '该房屋没有生效中的这条标准挂接');
    return { detached: true };
  }

  /**
   * 批量挂接 —— 导入 555 套之后逐套点是不可能的。
   * skipDuplicates:已挂的静默跳过(幂等),返回实际新增数。
   */
  async bulkAttach(dto: BulkAttachDto, adminId: string) {
    await assertCommunityInTenant(this.prisma, dto.communityId);
    const rule = await this.prisma.t.feeRule.findUnique({ where: { id: dto.ruleId } });
    if (!rule) throw new BizException(ErrorCode.NOT_FOUND, '收费标准不存在');
    if (rule.communityId !== dto.communityId) {
      throw new BizException(ErrorCode.VALIDATION, '该收费标准属于其他小区');
    }
    /*
     * 只挂真属于这个小区的房 —— houseIds 由前端勾选传来,不可信;
     * 差集如实返回,不静默吞(「挂上了 500 套」实际 480 套是假消息)。
     */
    const houses = await this.prisma.t.house.findMany({
      where: { id: { in: dto.houseIds }, communityId: dto.communityId },
      select: { id: true },
    });
    const validIds = new Set(houses.map((h) => h.id));
    const invalid = dto.houseIds.filter((id) => !validIds.has(id));

    const res = await this.prisma.t.houseStandard.createMany({
      data: [...validIds].map((houseId) => ({
        houseId,
        ruleId: dto.ruleId,
        createdBy: adminId,
      })) as Prisma.HouseStandardCreateManyInput[],
      skipDuplicates: true,
    });
    return { attached: res.count, alreadyAttached: validIds.size - res.count, invalidHouseIds: invalid };
  }
}

@Controller('admin')
@UseGuards(AdminGuard, RolesGuard)
export class HouseStandardsController {
  constructor(private readonly service: HouseStandardsService) {}

  @Get('houses/:id/standards')
  list(@Param('id') houseId: string) {
    return this.service.listForHouse(houseId);
  }

  @Post('houses/:id/standards')
  attach(@Current() cur: CurrentAdmin, @Param('id') houseId: string, @Body() dto: AttachDto) {
    return this.service.attach(houseId, dto, cur.adminId);
  }

  @Delete('houses/:id/standards/:ruleId')
  detach(@Param('id') houseId: string, @Param('ruleId') ruleId: string) {
    return this.service.detach(houseId, ruleId);
  }

  @Post('house-standards/bulk')
  bulk(@Current() cur: CurrentAdmin, @Body() dto: BulkAttachDto) {
    return this.service.bulkAttach(dto, cur.adminId);
  }
}
