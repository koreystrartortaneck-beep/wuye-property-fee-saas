import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { HOUSE_TYPES, HouseType } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class HouseRowDto {
  @IsIn(HOUSE_TYPES as unknown as string[])
  type!: HouseType;

  @IsOptional()
  @IsString()
  building?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  room?: string;

  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  displayName!: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  area?: number;

  @IsOptional()
  @IsString()
  ownerName?: string;

  @IsOptional()
  @IsString()
  ownerPhone?: string;
}

class ImportHousesDto {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  @IsArray()
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
  displayName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  area?: number;

  @IsOptional()
  @IsString()
  ownerName?: string;

  @IsOptional()
  @IsString()
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
    let created = 0;
    let updated = 0;
    const failed: { index: number; reason: string }[] = [];

    for (let i = 0; i < dto.rows.length; i++) {
      const row = dto.rows[i];
      const reason = this.validateRow(row);
      if (reason) {
        failed.push({ index: i, reason });
        continue;
      }
      try {
        const exists = await this.prisma.t.house.findFirst({
          where: { communityId: dto.communityId, code: row.code },
        });
        if (exists) {
          await this.prisma.t.house.update({ where: { id: exists.id }, data: { ...row } });
          updated++;
        } else {
          await this.prisma.t.house.create({
            data: { ...row, communityId: dto.communityId } as never,
          });
          created++;
        }
      } catch (e) {
        failed.push({ index: i, reason: e instanceof Error ? e.message : '未知错误' });
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
