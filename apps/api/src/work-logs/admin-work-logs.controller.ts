import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { WORK_CATEGORIES, WorkCategory } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class CreateWorkLogDto {
  @IsString()
  @IsNotEmpty()
  communityId!: string;

  @IsIn(WORK_CATEGORIES as unknown as string[])
  category!: WorkCategory;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(9)
  @IsString({ each: true })
  images!: string[];

  @IsOptional()
  @IsString()
  staffName?: string;
}

class ListWorkLogsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(WORK_CATEGORIES as unknown as string[])
  category?: WorkCategory;
}

@Controller('admin/work-logs')
@UseGuards(AdminGuard, RolesGuard)
export class AdminWorkLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  create(@Current() cur: CurrentAdmin, @Body() dto: CreateWorkLogDto) {
    return this.prisma.t.workLog.create({ data: { ...dto, createdBy: cur.adminId } as never });
  }

  @Get()
  async list(@Query() q: ListWorkLogsQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.category ? { category: q.category } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.workLog.findMany({ where, ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.workLog.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.prisma.t.workLog.delete({ where: { id } });
  }
}
