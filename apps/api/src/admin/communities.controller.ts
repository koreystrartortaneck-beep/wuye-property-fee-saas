import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

class CreateCommunityDto {
  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  servicePhone?: string;
}

class UpdateCommunityDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  servicePhone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Injectable()
export class CommunitiesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateCommunityDto) {
    /*
     * tenantId 由租户隔离扩展自动写入，所以类型上要 Omit 掉它 ——
     * 但**不能**因此把整个 data 转成 never：那会连带关掉其余所有字段的校验，
     * 字段名写错、类型不符都要等到运行时才炸。写操作出错就是数据错。
     *
     * 用 Unchecked 版：扩展注入的是标量 tenantId，而 CommunityCreateInput 因为有
     * tenant 关联字段，要求的是 { tenant: { connect } } 形状。
     */
    const data: Omit<Prisma.CommunityUncheckedCreateInput, 'tenantId'> = { ...dto };
    return this.prisma.t.community.create({ data: data as Prisma.CommunityUncheckedCreateInput });
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
