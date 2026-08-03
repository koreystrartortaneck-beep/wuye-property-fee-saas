import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { AuthService, maskPhone } from './auth.service';
import { Current, CurrentOwner } from './current.decorator';
import { OwnerGuard } from './owner.guard';
import { RateLimit } from '../common/rate-limit.guard';

class WxLoginDto {
  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  code!: string;
}

class PhoneDto {
  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  code!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /*
   * 每次调用都会向微信 jscode2session 外呼。配额是按小程序算的，刷爆之后所有业主都
   * 登录不了。20 次/分钟对正常业主绝对够（登录是进入小程序时一次），对刷量远远不够。
   */
  @RateLimit({ limit: 20, windowMs: 60_000, message: '登录请求过于频繁，请稍后再试' })
  @Post('wx-login')
  wxLogin(
    @Body() dto: WxLoginDto,
    @Headers('x-wx-openid') wxOpenid?: string,
    @Headers('x-wx-source') wxSource?: string,
    @Headers('x-wx-appid') wxAppid?: string,
    @Headers('x-authmethod') authMethod?: string,
  ) {
    const cloudRuntime = !!process.env.WX_CLOUD_ENV;
    const trustedCloudRequest =
      cloudRuntime &&
      (wxSource === 'wx_client' || wxSource === 'wx_devtools' || authMethod === 'WX_SERVER_AUTH');
    let trustedOpenid: string | undefined;
    if (trustedCloudRequest) {
      const expectedAppid = process.env.WX_APPID || '';
      if (!expectedAppid || !wxAppid || wxAppid !== expectedAppid) {
        throw new BizException(ErrorCode.UNAUTHORIZED, '小程序 AppID 不匹配');
      }
      trustedOpenid = wxOpenid || undefined;
    }
    return this.auth.wxLogin(dto.code, trustedOpenid);
  }

  // 手机号授权同样外呼微信，且它是绑定房屋的前置步骤，正常业主一辈子点几次
  @RateLimit({ limit: 10, windowMs: 60_000, message: '获取手机号过于频繁，请稍后再试' })
  @Post('phone')
  @UseGuards(OwnerGuard)
  phone(@Current() cur: CurrentOwner, @Body() dto: PhoneDto) {
    return this.auth.bindPhone(cur.ownerId, dto.code);
  }

  @Get('me')
  @UseGuards(OwnerGuard)
  async me(@Current() cur: CurrentOwner) {
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: cur.ownerId } });
    return { id: user?.id, phone: maskPhone(user?.phone), hasPhone: !!user?.phone };
  }

  /*
   * 业主令牌 → 管理员令牌(小程序管理端的免密登录)。
   *
   * 物业人员不用电脑,管理端做在业主小程序里(分包)。认证凭据是
   * 微信授权手机号 —— 运营商核验过的本人号码,伪造不了别人的号,
   * 强度等同短信验证码登录;名单(AdminUser.phone)由 TENANT_ADMIN 管理。
   *
   * 静默调用:小程序每次打开都会试一次,是管理员就亮出「物业管理」入口。
   * 所以两条响应路径都必须是 200:
   *   不是管理员 → { admin: null } —— 这不是错误,是绝大多数用户的正常答案
   *   是管理员   → 管理员令牌 + 角色(角色随令牌走,退款等仍限 TENANT_ADMIN)
   *
   * 审计只记成功换发(ADMIN_PHONE_LOGIN):记「谁在什么时候拿到了管理权」;
   * 普通业主的静默探测不记 —— 那是噪音,会把真正的登录淹掉。
   */
  @RateLimit({ limit: 10, windowMs: 60_000, message: '请求过于频繁，请稍后再试' })
  @Post('admin-exchange')
  @UseGuards(OwnerGuard)
  async adminExchange(@Current() cur: CurrentOwner) {
    const user = await this.prisma.raw.wxUser.findUnique({ where: { id: cur.ownerId } });
    if (!user?.phone) return { admin: null };
    const admin = await this.prisma.raw.adminUser.findUnique({ where: { phone: user.phone } });
    if (!admin || admin.status !== 'ACTIVE') return { admin: null };
    if (admin.tenantId) {
      const tenant = await this.prisma.raw.tenant.findUnique({ where: { id: admin.tenantId }, select: { status: true } });
      if (tenant?.status !== 'ACTIVE') return { admin: null };
    }
    // mustChangePassword 的受限会话不给小程序:那是密码体系的状态,免密通道直接拒
    if (admin.mustChangePassword) return { admin: null };

    const token = await this.auth.signAdminToken({
      sub: admin.id,
      tenantId: admin.tenantId,
      role: admin.role,
      ver: admin.tokenVersion,
    });
    if (admin.tenantId) {
      await runWithTenant(admin.tenantId, () =>
        this.audit.append({
          tenantId: admin.tenantId!,
          actorType: 'ADMIN',
          actorId: admin.id,
          action: 'CREATE',
          resourceType: 'AdminSession',
          resourceId: admin.id,
          afterSummary: { event: 'ADMIN_PHONE_LOGIN', via: 'miniprogram', wxUserId: cur.ownerId },
        }),
      );
    }
    return { admin: { name: admin.name, role: admin.role, token } };
  }
}
