import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { assertStrongPassword } from '../auth/auth.service';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsString()
  @IsNotEmpty()
  adminUsername!: string;

  @IsString()
  @MinLength(6)
  adminPassword!: string;
}

class UpdateTenantDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 创建租户 + 初始管理员（平台操作，用 raw） */
  async create(dto: CreateTenantDto) {
    assertStrongPassword(dto.adminPassword); // 强口令策略（Task 3）
    const exists = await this.prisma.raw.tenant.findUnique({ where: { code: dto.code } });
    if (exists) throw new BizException(ErrorCode.VALIDATION, `租户编码 ${dto.code} 已存在`);
    const userExists = await this.prisma.raw.adminUser.findUnique({ where: { username: dto.adminUsername } });
    if (userExists) throw new BizException(ErrorCode.VALIDATION, `账号 ${dto.adminUsername} 已存在`);

    return this.prisma.raw.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: dto.name, code: dto.code, contactName: dto.contactName, contactPhone: dto.contactPhone },
      });
      await tx.adminUser.create({
        data: {
          tenantId: tenant.id,
          username: dto.adminUsername,
          passwordHash: await bcrypt.hash(dto.adminPassword, 10),
          name: `${dto.name}管理员`,
          role: 'TENANT_ADMIN',
        },
      });
      return tenant;
    });
  }

  async list(q: PageQuery) {
    const [list, total] = await Promise.all([
      this.prisma.raw.tenant.findMany({ ...pageArgs(q), orderBy: { createdAt: 'desc' } }),
      this.prisma.raw.tenant.count(),
    ]);
    return pageResult(list, total, q);
  }

  async update(id: string, dto: UpdateTenantDto) {
    return this.prisma.raw.tenant.update({ where: { id }, data: dto });
  }
}

@Controller('admin/tenants')
@UseGuards(AdminGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class TenantsController {
  constructor(private readonly service: TenantsService) {}

  @Post()
  create(@Body() dto: CreateTenantDto) {
    return this.service.create(dto);
  }

  @Get()
  list(@Query() q: PageQuery) {
    return this.service.list(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.service.update(id, dto);
  }
}
