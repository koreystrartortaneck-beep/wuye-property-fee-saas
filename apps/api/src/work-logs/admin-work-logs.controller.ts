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
import { Prisma } from '@prisma/client';
import { assertCommunityInTenant } from '../admin/community-scope';
import { PrismaService } from '../prisma/prisma.service';
import { signUploadPaths, stripUploadSignature } from '../upload/upload-access';

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
  @MaxLength(100)
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
  async create(@Current() cur: CurrentAdmin, @Body() dto: CreateWorkLogDto) {
    await assertCommunityInTenant(this.prisma, dto.communityId);
    /*
     * 不用 `as never`：那会把整个 data 的字段校验关掉 —— 字段名写错、类型不符都编译通过，
     * 直到运行时才炸。这里显式列字段，tenantId 由 prisma.t 注入。
     *
     * images 先剥签名：响应出口会统一给 /uploads/ 路径加访问令牌，若前端把读到的
     * 带签名地址提交回来，入库的就是带令牌的路径，10 分钟后这条记录的图永久打不开。
     */
    const data: Omit<Prisma.WorkLogCreateInput, 'tenantId'> = {
      communityId: dto.communityId,
      category: dto.category,
      title: dto.title ?? null,
      description: dto.description ?? null,
      images: stripUploadSignature(dto.images),
      staffName: dto.staffName ?? null,
      createdBy: cur.adminId,
    };
    return this.prisma.t.workLog.create({ data: data as Prisma.WorkLogCreateInput });
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
    /*
     * 图片地址读取时现签：存库的是裸路径，签名只有 10 分钟有效——
     * 把带签名的地址存进库，10 分钟后所有历史图片全部打不开。
     */
    return pageResult(
      list.map((w) => ({ ...w, images: signUploadPaths(w.images) })),
      total,
      q,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.prisma.t.workLog.delete({ where: { id } });
  }
}
