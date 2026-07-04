import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class CreateAnnouncementDto {
  @IsOptional()
  @IsString()
  communityId?: string; // 不传 = 公司全部小区

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content!: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  content?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsIn(['PUBLISHED', 'REVOKED'])
  status?: 'PUBLISHED' | 'REVOKED';
}

@Controller('admin/announcements')
@UseGuards(AdminGuard, RolesGuard)
export class AdminAnnouncementsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  create(@Current() cur: CurrentAdmin, @Body() dto: CreateAnnouncementDto) {
    return this.prisma.t.announcement.create({
      data: { ...dto, communityId: dto.communityId || null, createdBy: cur.adminId } as never,
    });
  }

  @Get()
  async list(@Query() q: PageQuery) {
    const [list, total] = await Promise.all([
      this.prisma.t.announcement.findMany({
        ...pageArgs(q),
        orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
      }),
      this.prisma.t.announcement.count(),
    ]);
    return pageResult(list, total, q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.prisma.t.announcement.update({ where: { id }, data: dto });
  }
}
