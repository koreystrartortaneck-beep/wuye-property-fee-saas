import { Body, Controller, Get, Injectable, Ip, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { AuthService, assertStrongPassword, BCRYPT_COST, normalizePhone } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const IP_WINDOW_MS = 60_000;
const IP_MAX = 30;
/** ipHits 的条目上界，超过即淘汰过期项（防内存无限增长） */
const IP_TABLE_MAX = 10_000;

class AdminLoginDto {
  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  username!: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  oldPassword!: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  newPassword!: string;
}

@Injectable()
export class AdminAuthService {
  // 单实例内存 IP 限流（min=1 常驻，灰度足够；水平扩展时应换共享存储）
  private readonly ipHits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private ipRateLimited(ip?: string): boolean {
    if (!ip) return false;
    const now = Date.now();
    /*
     * 顺手清掉过期条目并设上界。这个 Map 原先没有任何淘汰逻辑：每个来过的 IP 都会
     * 留一条，是一个持续增长的内存点（开了 trust proxy 之后 key 从「网关那一个 IP」
     * 变成「所有真实客户端 IP」，增长会明显加快）。
     * 阈值以上直接整表重建：限流本身是尽力而为，宁可放过一轮也不要无限增长。
     */
    if (this.ipHits.size > IP_TABLE_MAX) {
      for (const [k, v] of this.ipHits) if (v.resetAt < now) this.ipHits.delete(k);
      if (this.ipHits.size > IP_TABLE_MAX) this.ipHits.clear();
    }
    const e = this.ipHits.get(ip);
    if (!e || e.resetAt < now) {
      this.ipHits.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
      return false;
    }
    e.count += 1;
    return e.count > IP_MAX;
  }

  private profileOf(admin: { name: string; role: string; tenantId: string | null }) {
    return { name: admin.name, role: admin.role, tenantId: admin.tenantId };
  }

  async login(username: string, password: string, ip?: string) {
    // 中性错误：绝不透露是用户名还是密码错、账号是否存在
    const invalid = () => new BizException(ErrorCode.UNAUTHORIZED, '用户名或密码错误');
    if (this.ipRateLimited(ip)) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '尝试过于频繁，请稍后再试');
    }
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { username } });
    if (!admin) throw invalid();

    const now = new Date();
    if (admin.lockedUntil && admin.lockedUntil > now) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '账号已锁定，请稍后再试');
    }
    // 禁用账号：用中性错误拒绝，不暴露账号存在
    if (admin.status !== 'ACTIVE') throw invalid();

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      const failed = admin.failedLoginCount + 1;
      const data: { failedLoginCount: number; lockedUntil?: Date } = { failedLoginCount: failed };
      if (failed >= MAX_FAILS) {
        data.lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000);
        data.failedLoginCount = 0;
      }
      await this.prisma.raw.adminUser.update({ where: { id: admin.id }, data });
      throw invalid();
    }

    // 成功：清零失败计数与锁定
    await this.prisma.raw.adminUser.update({
      where: { id: admin.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    const token = await this.auth.signAdminToken({
      sub: admin.id,
      tenantId: admin.tenantId,
      role: admin.role,
      ver: admin.tokenVersion,
      mcp: admin.mustChangePassword || undefined,
    });
    return {
      token,
      profile: this.profileOf(admin),
      mustChangePassword: admin.mustChangePassword,
    };
  }

  async changePassword(adminId: string, oldPassword: string, newPassword: string) {
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new BizException(ErrorCode.UNAUTHORIZED);
    if (!(await bcrypt.compare(oldPassword, admin.passwordHash))) {
      throw new BizException(ErrorCode.VALIDATION, '原密码错误');
    }
    if (await bcrypt.compare(newPassword, admin.passwordHash)) {
      throw new BizException(ErrorCode.VALIDATION, '新密码不能与原密码相同');
    }
    assertStrongPassword(newPassword);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const updated = await this.prisma.raw.adminUser.update({
      where: { id: adminId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        tokenVersion: { increment: 1 }, // 使旧令牌全部失效
      },
    });
    const token = await this.auth.signAdminToken({
      sub: updated.id,
      tenantId: updated.tenantId,
      role: updated.role,
      ver: updated.tokenVersion,
    });
    return { token, profile: this.profileOf(updated) };
  }
}

class SetStaffPhoneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username!: string;

  /** 空串 = 解除(收回小程序管理入口) */
  @IsString()
  @MaxLength(32)
  phone!: string;
}

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly service: AdminAuthService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  login(@Body() dto: AdminLoginDto, @Ip() ip: string) {
    return this.service.login(dto.username, dto.password, ip);
  }

  /*
   * 登记/解除员工手机号 —— 小程序管理端免密登录的凭据名单。
   *
   * 这个名单就是管理权的边界:号在名单上,微信授权手机号即获管理令牌。
   * 所以限 TENANT_ADMIN、只能改本租户账号、每次变更审计(before/after 都记,
   * 审计层会自动给 phone 键脱敏)。
   */
  @Roles('TENANT_ADMIN')
  @UseGuards(AdminGuard, RolesGuard)
  @Post('staff-phone')
  async setStaffPhone(@Current() cur: CurrentAdmin, @Body() dto: SetStaffPhoneDto) {
    const target = await this.prisma.raw.adminUser.findUnique({ where: { username: dto.username } });
    if (!target || target.tenantId !== cur.tenantId) {
      throw new BizException(ErrorCode.NOT_FOUND, '该账号不存在或不属于本物业公司');
    }
    const phone = dto.phone.trim() ? normalizePhone(dto.phone) : null;
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      throw new BizException(ErrorCode.VALIDATION, '请填写 11 位大陆手机号');
    }
    try {
      await this.prisma.raw.adminUser.update({ where: { id: target.id }, data: { phone } });
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002') {
        throw new BizException(ErrorCode.VALIDATION, '该手机号已登记在其他管理账号上');
      }
      throw e;
    }
    await this.audit.append({
      tenantId: cur.tenantId!,
      actorType: 'ADMIN',
      actorId: cur.adminId,
      action: 'UPDATE',
      resourceType: 'AdminUser',
      resourceId: target.id,
      // 键名避开脱敏词表;尾 4 位足以核对是谁的号,全号绝不进审计
      beforeSummary: { contactTail: target.phone ? target.phone.slice(-4) : null },
      afterSummary: { event: 'ADMIN_STAFF_PHONE_SET', username: target.username, contactTail: phone ? phone.slice(-4) : null },
    });
    return { username: target.username, phone: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : null };
  }

  /** 受限会话（mustChangePassword）唯一允许访问的端点 */
  @Post('change-password')
  @UseGuards(AdminGuard)
  changePassword(@Current() cur: CurrentAdmin, @Body() dto: ChangePasswordDto) {
    return this.service.changePassword(cur.adminId, dto.oldPassword, dto.newPassword);
  }

  @Get('profile')
  @UseGuards(AdminGuard)
  async profile(@Current() cur: CurrentAdmin) {
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { id: cur.adminId } });
    return { name: admin?.name, role: cur.role, tenantId: cur.tenantId };
  }
}
