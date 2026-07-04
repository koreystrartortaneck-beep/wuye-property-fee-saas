import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class CreateCommunityDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  servicePhone?: string;
}

class UpdateCommunityDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  servicePhone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Injectable()
export class CommunitiesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateCommunityDto) {
    // tenantId 由租户隔离扩展自动写入
    return this.prisma.t.community.create({ data: dto as never });
  }

  async list(q: PageQuery) {
    const [list, total] = await Promise.all([
      this.prisma.t.community.findMany({ ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.t.community.count(),
    ]);
    return pageResult(list, total, q);
  }

  update(id: string, dto: UpdateCommunityDto) {
    return this.prisma.t.community.update({ where: { id }, data: dto });
  }
}

@Controller('admin/communities')
@UseGuards(AdminGuard, RolesGuard)
export class CommunitiesController {
  constructor(private readonly service: CommunitiesService) {}

  @Post()
  create(@Body() dto: CreateCommunityDto) {
    return this.service.create(dto);
  }

  @Get()
  list(@Query() q: PageQuery) {
    return this.service.list(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCommunityDto) {
    return this.service.update(id, dto);
  }
}
