import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { BCRYPT_COST, assertStrongPassword, generateInitialPassword } from '../auth/auth.service';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { BizException } from '../common/biz.exception';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

class CreateTenantDto {
  @IsString()
  @MaxLength(100)
  @IsNotEmpty()
  name!: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  contactPhone?: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  adminUsername!: string;

  @IsString()
  @MaxLength(64)
  @MinLength(6)
  adminPassword!: string;
}

class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  contactPhone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
          passwordHash: await bcrypt.hash(dto.adminPassword, BCRYPT_COST),
          name: `${dto.name}管理员`,
          role: 'TENANT_ADMIN',
          /*
           * 首次登录强制改密。
           *
           * AdminGuard 早就实现了这个控制（mustChangePassword 为真时只放行改密端点），
           * schema 也有这个字段——但**没有任何代码路径会把它设为 true**：默认值是
           * false，全库只有一次性迁移把存量账号置过 true。于是超管指定的初始密码会
           * 一直用下去，超管长期知道每个租户管理员的密码。
           */
          mustChangePassword: true,
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
    /*
     * 带出该租户的管理员账号。
     *
     * 重置密码需要 adminId，而列表原先只有租户本身 —— 端点存在但界面上拿不到参数，
     * 等于没有入口。一次批量查而不是逐个租户查（租户数量不大但没有理由发 N 次请求）。
     * 只取账号名与强制改密状态，不带 passwordHash。
     */
    const admins = list.length
      ? await this.prisma.raw.adminUser.findMany({
          where: { tenantId: { in: list.map((t) => t.id) }, role: 'TENANT_ADMIN' },
          select: { id: true, tenantId: true, username: true, mustChangePassword: true, status: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const byTenant = new Map<string, typeof admins>();
    for (const a of admins) {
      if (!a.tenantId) continue;
      byTenant.set(a.tenantId, [...(byTenant.get(a.tenantId) ?? []), a]);
    }
    return pageResult(
      list.map((t) => ({ ...t, admins: byTenant.get(t.id) ?? [] })),
      total,
      q,
    );
  }

  async update(id: string, dto: UpdateTenantDto) {
    return this.prisma.raw.tenant.update({ where: { id }, data: dto });
  }

  /**
   * 重置某租户管理员的密码，返回一次性初始口令。
   *
   * 为什么必须有这个端点：管理员忘记密码时，此前唯一的出路是直连数据库改哈希，
   * 或者用灰度期那个后门模块的 mkadmin —— 而 mkadmin 能造超管、绕过强口令校验、
   * 把 mustChangePassword 置 false、还不写任何审计。**缺失的合法通道会长期把不安全的
   * 通道留在代码里**，所以先补上这条正路，那个后门才有底气删（已删）。
   *
   * 三条设计取舍：
   * · 口令由服务端随机生成，不由超管指定 —— 否则超管仍然长期知道对方的密码；
   * · 强制 mustChangePassword，对方登录后第一件事就是改掉；
   * · tokenVersion +1 吊销该账号全部旧令牌 —— 忘记密码往往伴随「怀疑号被别人用了」。
   *
   * 口令只在本次响应里返回一次，不落库明文、不写进审计（审计只记「谁在何时重置了谁」）。
   */
  async resetAdminPassword(
    tenantId: string,
    adminId: string,
    operatorId: string,
  ): Promise<{ username: string; password: string }> {
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || admin.tenantId !== tenantId) {
      throw new BizException(ErrorCode.NOT_FOUND, '该租户下没有这个管理员账号');
    }
    if (admin.role === 'SUPER_ADMIN') {
      // 超管不该由这个「按租户重置」的入口处理：它没有租户维度，也不该被平台侧互相重置
      throw new BizException(ErrorCode.FORBIDDEN, '超级管理员账号不能通过租户入口重置');
    }
    const password = generateInitialPassword();
    assertStrongPassword(password); // 生成器若被改坏，这里直接拦住
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: adminId },
        data: {
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          // 忘记密码常伴随「怀疑号被人用了」，把旧会话一并吊销
          tokenVersion: { increment: 1 },
        },
      });
      await this.audit.append(
        {
          tenantId,
          actorType: 'ADMIN',
          actorId: operatorId,
          action: 'UPDATE',
          resourceType: 'AdminUser',
          resourceId: adminId,
          reason: '超管重置密码',
          // 绝不把口令写进审计
          afterSummary: { event: 'PASSWORD_RESET', mustChangePassword: true },
        },
        tx as never,
      );
    });

    return { username: admin.username, password };
  }
}

@Controller('admin/tenants')
@UseGuards(AdminGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class TenantsController {
  constructor(private readonly service: TenantsService) {}

  @Post(':tenantId/admins/:adminId/reset-password')
  resetAdminPassword(
    @Current() cur: CurrentAdmin,
    @Param('tenantId') tenantId: string,
    @Param('adminId') adminId: string,
  ) {
    return this.service.resetAdminPassword(tenantId, adminId, cur.adminId);
  }

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
