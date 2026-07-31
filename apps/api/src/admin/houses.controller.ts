import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { HOUSE_TYPES, HouseType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { assertCommunityInTenant } from './community-scope';
import { PrismaService } from '../prisma/prisma.service';

class HouseRowDto {
  @IsIn(HOUSE_TYPES as unknown as string[])
  type!: HouseType;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  building?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  room?: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  code!: string;

  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  displayName!: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  area?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ownerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerPhone?: string;
}

class ImportHousesDto {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  /*
   * 行数上限。原先没有任何限制，只被 Express 默认 100KB 的 body 限制间接卡在约
   * 600 行——超过就返回 413，物业看到的是一个无法理解的错误而不是业务提示。
   * 2000 行覆盖一栋楼到一个中型小区，且批量化改造后写入耗时可控。
   */
  @IsArray()
  @ArrayMaxSize(2000, { message: '单次最多导入 2000 行，请拆分文件' })
  @ValidateNested({ each: true })
  @Type(() => HouseRowDto)
  rows!: HouseRowDto[];
}

class ListHousesQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(HOUSE_TYPES as unknown as string[])
  type?: HouseType;

  @IsOptional()
  @IsString()
  keyword?: string;
}

class UpdateHouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  area?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ownerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerPhone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Injectable()
export class HousesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 单行业务校验：住宅必须有面积 */
  private validateRow(row: HouseRowDto): string | null {
    if (row.type === 'RESIDENCE' && (row.area === undefined || row.area <= 0)) {
      return '住宅必须填写建筑面积';
    }
    return null;
  }

  /** 批量导入：唯一键 (communityId, code) upsert，逐行汇报结果 */
  async import(dto: ImportHousesDto) {
    /*
     * 先确认小区属于本公司再导入。
     *
     * 不校验的话，一批房屋会挂到别家公司的小区上：prisma.t 保证 tenantId 是对的，
     * 但 communityId 指向别处 —— 房屋在本公司的任何列表里都查不到（列表按小区过滤），
     * 而导入结果显示「成功 N 条」。物业会以为导好了，直到发现房屋一个都不在。
     */
    await assertCommunityInTenant(this.prisma, dto.communityId);
    let created = 0;
    let updated = 0;
    const failed: { index: number; reason: string }[] = [];

    /*
     * 一次查出已存在的房号，新增走 createMany，只有确实要改的行才逐条 update。
     *
     * 原实现每行 2-3 次数据库往返（findFirst + update/create）：
     *   600 行 → 约 1200 次 ≈ 3.6s
     *  2000 行 → 约 4000 次 ≈ 12s，请求很可能撞网关超时，而此时后台还在继续写，
     *            物业不知道到底导进去多少
     * 现在是 2 次 + 需更新的行数。
     */
    const valid: HouseRowDto[] = [];
    for (let i = 0; i < dto.rows.length; i++) {
      const reason = this.validateRow(dto.rows[i]);
      if (reason) failed.push({ index: i, reason });
      else valid.push(dto.rows[i]);
    }

    const existing = valid.length
      ? await this.prisma.t.house.findMany({
          where: { communityId: dto.communityId, code: { in: valid.map((r) => r.code) } },
          select: { id: true, code: true },
        })
      : [];
    const idByCode = new Map(existing.map((h) => [h.code, h.id]));

    const toCreate = valid.filter((r) => !idByCode.has(r.code));
    if (toCreate.length) {
      const res = await this.prisma.t.house.createMany({
        /*
         * 只对 tenantId 留类型出口 —— 它由 prisma.t 的租户扩展自动注入
         * （tenant-extension 的 injectData 对数组也逐项注入），这里不能写也不该写。
         * 不用 `as never`：那会让 Prisma 对**其余所有字段**的校验一并失效，
         * 而 createMany 是批量写，错一个字段名就是几千行脏数据。
         */
        data: toCreate.map((r) => ({ ...r, communityId: dto.communityId })) as Prisma.HouseCreateManyInput[],
        // 兜住 @@unique([communityId, code])：同一次导入里文件内重复的房号
        skipDuplicates: true,
      });
      created = res.count;
    }

    for (const row of valid) {
      const id = idByCode.get(row.code);
      if (!id) continue;
      try {
        await this.prisma.t.house.update({ where: { id }, data: { ...row } });
        updated++;
      } catch (e) {
        failed.push({
          index: dto.rows.indexOf(row),
          reason: e instanceof Error ? e.message : '未知错误',
        });
      }
    }
    return { created, updated, failed };
  }

  async list(q: ListHousesQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.keyword
        ? { OR: [{ code: { contains: q.keyword } }, { displayName: { contains: q.keyword } }, { ownerName: { contains: q.keyword } }, { ownerPhone: { contains: q.keyword } }] }
        : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.house.findMany({ where, ...pageArgs(q), orderBy: { code: 'asc' } }),
      this.prisma.t.house.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  update(id: string, dto: UpdateHouseDto) {
    return this.prisma.t.house.update({ where: { id }, data: dto });
  }
}

@Controller('admin/houses')
@UseGuards(AdminGuard, RolesGuard)
export class HousesController {
  constructor(private readonly service: HousesService) {}

  @Post('import')
  import(@Body() dto: ImportHousesDto) {
    return this.service.import(dto);
  }

  @Get()
  list(@Query() q: ListHousesQuery) {
    return this.service.list(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateHouseDto) {
    return this.service.update(id, dto);
  }
}
