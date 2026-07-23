import { Body, Controller, Get, Injectable, Ip, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { ErrorCode } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { AuthService, assertStrongPassword } from '../auth/auth.service';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const IP_WINDOW_MS = 60_000;
const IP_MAX = 30;

class AdminLoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @IsString()
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
    const passwordHash = await bcrypt.hash(newPassword, 10);
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

@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly service: AdminAuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  login(@Body() dto: AdminLoginDto, @Ip() ip: string) {
    return this.service.login(dto.username, dto.password, ip);
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
