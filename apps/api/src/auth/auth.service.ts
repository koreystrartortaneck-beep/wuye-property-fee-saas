import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { WX_API, WxApi } from '../wx/wx.service';

export interface OwnerJwtPayload {
  sub: string; // WxUser.id
  typ: 'owner';
}

export interface AdminJwtPayload {
  sub: string; // AdminUser.id
  typ: 'admin';
  tenantId: string | null;
  role: string;
  ver: number; // tokenVersion，改密/吊销时递增使旧令牌失效
  mcp?: boolean; // mustChangePassword：受限会话（仅可改密）
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(WX_API) private readonly wx: WxApi,
  ) {}

  /** 微信登录：优先使用云托管可信 openid，否则用 code 换取，落库并签发 owner token */
  async wxLogin(code: string, trustedOpenid?: string): Promise<{ token: string; user: { id: string; hasPhone: boolean } }> {
    const openid = trustedOpenid || (await this.wx.code2session(code)).openid;
    const user = await this.prisma.raw.wxUser.upsert({
      where: { openid },
      create: { openid },
      update: {},
    });
    const payload: OwnerJwtPayload = { sub: user.id, typ: 'owner' };
    return {
      token: await this.jwt.signAsync(payload, { expiresIn: '7d' }),
      user: { id: user.id, hasPhone: !!user.phone },
    };
  }

  /**
   * 手机号授权：存手机号 → 按 House.ownerPhone 自动匹配并建 ACTIVE 绑定。
   * 业主天然跨租户，使用 raw client（spec §6.2）。
   */
  async bindPhone(wxUserId: string, code: string): Promise<{ phone: string; matchedHouses: number }> {
    const { phone } = await this.wx.getPhoneNumber(code);
    await this.prisma.raw.wxUser.update({ where: { id: wxUserId }, data: { phone } });

    const houses = await this.prisma.raw.house.findMany({
      where: { ownerPhone: phone, status: 'ACTIVE' },
    });
    for (const house of houses) {
      await this.prisma.raw.houseBinding.upsert({
        where: { wxUserId_houseId: { wxUserId, houseId: house.id } },
        create: {
          tenantId: house.tenantId,
          wxUserId,
          houseId: house.id,
          relation: 'OWNER',
          status: 'ACTIVE',
          source: 'PHONE_MATCH',
        },
        // 已有申请中/被拒的记录 → 手机号匹配直接转正
        update: { status: 'ACTIVE', source: 'PHONE_MATCH' },
      });
    }
    return { phone, matchedHouses: houses.length };
  }

  async verifyToken<T extends OwnerJwtPayload | AdminJwtPayload>(token: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token);
    } catch {
      throw new BizException(ErrorCode.UNAUTHORIZED);
    }
  }

  signAdminToken(payload: Omit<AdminJwtPayload, 'typ'>): Promise<string> {
    return this.jwt.signAsync({ ...payload, typ: 'admin' }, { expiresIn: '12h' });
  }
}

/** 强口令策略：≥12 位，且至少包含字母与数字，不得为纯重复字符（Task 3）。 */
export function assertStrongPassword(pw: string): void {
  const ok =
    typeof pw === 'string' &&
    pw.length >= 12 &&
    /[A-Za-z]/.test(pw) &&
    /\d/.test(pw) &&
    !/^(.)\1+$/.test(pw);
  if (!ok) {
    throw new BizException(ErrorCode.VALIDATION, '密码至少 12 位，且须包含字母和数字');
  }
}
