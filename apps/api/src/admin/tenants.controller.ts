import { Body, Controller, Get, Injectable, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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

/** 启停管理员账号 */
class SetAdminStatusDto {
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: 'ACTIVE' | 'DISABLED';
}

/** 创建只读平台账号。口令由服务端生成，不由调用方指定。 */
class CreatePlatformReadonlyDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(64)
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name!: string;
}


@Injectable()
export class TenantsService {
  private readonly logger = new Logger('Tenants');

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
   * 启用/停用某租户下的管理员账号。
   *
   * 为什么需要这个端点：后台此前只能启停**整个租户**，没有任何办法处理单个账号。
   * 于是联调、灰度、离职留下的账号只能一直 ACTIVE 挂着 —— 生产上就有一个
   * `wxpay-test-admin`（微信支付联调时建的，从未登录过，mustChangePassword 仍为 true），
   * 而它是一个活着的 TENANT_ADMIN，能发起退款和冲正。
   *
   * 停用即时生效：AdminGuard 每次请求都查 status，且这里同时递增 tokenVersion
   * 吊销该账号已签发的全部令牌 —— 不然停用之后旧会话还能继续用 12 小时。
   */
  async setAdminStatus(
    tenantId: string,
    adminId: string,
    status: 'ACTIVE' | 'DISABLED',
    operatorId: string,
  ): Promise<{ username: string; status: string }> {
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || admin.tenantId !== tenantId) {
      throw new BizException(ErrorCode.NOT_FOUND, '该租户下没有这个管理员账号');
    }
    if (admin.role === 'SUPER_ADMIN') {
      throw new BizException(ErrorCode.FORBIDDEN, '超级管理员账号不能通过租户入口停用');
    }
    if (admin.id === operatorId) {
      // 把自己停掉会立刻锁死自己，且没有别的入口能恢复
      throw new BizException(ErrorCode.VALIDATION, '不能停用当前登录的账号');
    }

    await this.prisma.raw.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: adminId },
        data: {
          status,
          // 停用要吊销旧令牌；启用不必动，但一并递增更简单也更安全
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
          reason: status === 'DISABLED' ? '停用管理员账号' : '启用管理员账号',
          afterSummary: { status, tokenRevoked: true },
        },
        tx as never,
      );
    });

    return { username: admin.username, status };
  }

  /**
   * 创建只读平台账号，返回一次性初始口令。
   *
   * 没有这个入口的话 PLATFORM_READONLY 只是一个枚举值 —— 角色实现了但没人能拥有它，
   * 于是平台侧看数据仍然只能动用全权超管。这与「后门长期存在是因为缺少合法通道」
   * 是同一类问题：能力和入口必须一起给。
   *
   * tenantId 为 null（平台账号不属于任何租户），口令与重置流程一致：服务端随机生成、
   * 强制首次改密、只返回一次、不写进审计。
   */
  async createPlatformReadonly(
    username: string,
    name: string,
    operatorId: string,
  ): Promise<{ username: string; password: string }> {
    const exists = await this.prisma.raw.adminUser.findUnique({ where: { username } });
    if (exists) throw new BizException(ErrorCode.VALIDATION, `账号 ${username} 已存在`);

    const password = generateInitialPassword();
    assertStrongPassword(password);
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const created = await this.prisma.raw.adminUser.create({
      data: {
        // 平台账号不属于任何租户：落到某个租户下会让 AdminGuard 用 payload.tenantId
        // 而不是 X-Tenant-Id，这个账号就只能看那一个租户，「平台只读」名不副实
        tenantId: null,
        username,
        passwordHash,
        name,
        role: 'PLATFORM_READONLY',
        mustChangePassword: true,
      },
    });
    /*
     * 这一条刻意**不写 AuditLog**。
     *
     * AuditLog.tenantId 是 NOT NULL，且 assertTenantAccess 会校验它与当前租户上下文
     * 一致 —— 这是审计表的设计前提（每条留痕都归属某个租户，DB 层还有 append-only
     * 触发器和 ON DELETE RESTRICT 的外键）。而「创建平台账号」这个动作没有租户维度，
     * 硬塞一个租户 ID 会让那个租户的审计流里出现一条与它无关的记录，比不写更糟。
     *
     * 折中：记应用日志（已过脱敏器），口令不入日志。平台级动作的审计需要一张
     * 独立的 PlatformAuditLog 表，那是另一件事，不该在这里凑。
     */
    this.logger.log(`创建只读平台账号 username=${username} id=${created.id} by=${operatorId}`);

    return { username, password };
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

  @Patch(':tenantId/admins/:adminId/status')
  setAdminStatus(
    @Current() cur: CurrentAdmin,
    @Param('tenantId') tenantId: string,
    @Param('adminId') adminId: string,
    @Body() dto: SetAdminStatusDto,
  ) {
    return this.service.setAdminStatus(tenantId, adminId, dto.status, cur.adminId);
  }

  @Post('platform-readonly')
  createPlatformReadonly(@Current() cur: CurrentAdmin, @Body() dto: CreatePlatformReadonlyDto) {
    return this.service.createPlatformReadonly(dto.username, dto.name, cur.adminId);
  }

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
