import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';
import { WX_API, WxApi } from '../wx/wx.service';

export interface OwnerJwtPayload {
  sub: string; // WxUser.id
  typ: 'owner';
  ver?: number; // tokenVersion，注销/吊销时递增使旧令牌失效（缺省视为 0，向后兼容旧令牌）
}

export interface AdminJwtPayload {
  sub: string; // AdminUser.id
  typ: 'admin';
  tenantId: string | null;
  role: string;
  ver: number; // tokenVersion，改密/吊销时递增使旧令牌失效
  mcp?: boolean; // mustChangePassword：受限会话（仅可改密）
}

/** 规范化手机号：去空白与常见前缀，用于精确匹配 House.ownerPhone。 */
export function normalizePhone(raw: string): string {
  const trimmed = (raw ?? '').replace(/[\s-]/g, '');
  return trimmed.replace(/^\+?86/, '');
}

/** 客户端仅返回掩码手机号（保留前 3 后 4）。 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length < 7) return '****';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(WX_API) private readonly wx: WxApi,
    private readonly audit: AuditService,
  ) {}

  /** 微信登录：优先使用云托管可信 openid，否则用 code 换取，落库并签发 owner token */
  async wxLogin(code: string, trustedOpenid?: string): Promise<{ token: string; user: { id: string; hasPhone: boolean } }> {
    const openid = trustedOpenid || (await this.wx.code2session(code)).openid;
    const user = await this.prisma.raw.wxUser.upsert({
      where: { openid },
      create: { openid },
      update: {},
    });
    const payload: OwnerJwtPayload = { sub: user.id, typ: 'owner', ver: user.tokenVersion ?? 0 };
    return {
      token: await this.jwt.signAsync(payload, { expiresIn: '7d' }),
      user: { id: user.id, hasPhone: !!user.phone },
    };
  }

  /**
   * 手机号授权（证据感知绑定）：
   * - 精确规范化匹配 House.ownerPhone，命中房屋建/复活 PHONE_MATCH 绑定；
   * - 人工审批绑定（source=APPLY 或已 reviewedBy）不被手机匹配覆盖；
   * - 既有 PHONE_MATCH 但手机号已不再匹配的房屋 → 自动失效解绑，人工审批保留；
   * - 仅向客户端返回掩码手机号。
   * 业主天然跨租户，使用 raw client；审计按房屋所属租户上下文写入（同事务）。
   */
  async bindPhone(wxUserId: string, code: string): Promise<{ phone: string | null; matchedHouses: number }> {
    const { phone: rawPhone } = await this.wx.getPhoneNumber(code);
    const phone = normalizePhone(rawPhone);
    const now = new Date();
    await this.prisma.raw.wxUser.update({ where: { id: wxUserId }, data: { phone, phoneBoundAt: now } });

    const houses = await this.prisma.raw.house.findMany({ where: { ownerPhone: phone, status: 'ACTIVE' } });
    const matchedHouseIds = new Set(houses.map((h) => h.id));
    const existing = await this.prisma.raw.houseBinding.findMany({ where: { wxUserId } });
    const existingByHouse = new Map(existing.map((b) => [b.houseId, b]));

    await this.prisma.raw.$transaction(async (tx) => {
      // 1) 命中房屋：建立或复活 PHONE_MATCH 绑定，绝不覆盖人工审批证据。
      for (const house of houses) {
        const cur = existingByHouse.get(house.id);
        if (!cur) {
          const created = await tx.houseBinding.create({
            data: {
              tenantId: house.tenantId,
              wxUserId,
              houseId: house.id,
              relation: 'OWNER',
              status: 'ACTIVE',
              source: 'PHONE_MATCH',
              phoneMatchedAt: now,
            },
          });
          await this.appendBindingAudit(tx, house.tenantId, created.id, wxUserId, 'CREATE', {
            event: 'BINDING_PHONE_MATCH_CREATE',
            source: 'PHONE_MATCH',
            status: 'ACTIVE',
          });
          continue;
        }
        // 人工审批（APPLY 或已审核）证据：保留，不被手机匹配改写。
        if (cur.source === 'APPLY' || cur.reviewedBy) continue;
        if (cur.status !== 'ACTIVE' || cur.revokedAt) {
          await tx.houseBinding.updateMany({
            where: { id: cur.id },
            data: { status: 'ACTIVE', source: 'PHONE_MATCH', phoneMatchedAt: now, revokedAt: null, revokeReason: null },
          });
          await this.appendBindingAudit(tx, cur.tenantId, cur.id, wxUserId, 'UPDATE', {
            event: 'BINDING_PHONE_MATCH_REACTIVATE',
            source: 'PHONE_MATCH',
            status: 'ACTIVE',
          });
        }
      }
      // 2) 失效的仅手机匹配绑定：手机号已变更/不再匹配 → 自动解绑，人工审批不受影响。
      for (const b of existing) {
        if (b.source === 'PHONE_MATCH' && b.status === 'ACTIVE' && !matchedHouseIds.has(b.houseId)) {
          const upd = await tx.houseBinding.updateMany({
            where: { id: b.id, status: 'ACTIVE', source: 'PHONE_MATCH' },
            data: { status: 'REJECTED', revokedAt: now, revokeReason: '手机号变更，自动解除仅手机匹配绑定' },
          });
          if (upd.count === 1) {
            await this.appendBindingAudit(tx, b.tenantId, b.id, wxUserId, 'CANCEL', {
              event: 'BINDING_PHONE_MATCH_REVOKE',
              source: 'PHONE_MATCH',
              status: 'REJECTED',
              reason: '手机号变更',
            });
          }
        }
      }
    });

    return { phone: maskPhone(phone), matchedHouses: houses.length };
  }

  private appendBindingAudit(
    tx: Parameters<Parameters<PrismaService['raw']['$transaction']>[0]>[0],
    tenantId: string,
    bindingId: string,
    wxUserId: string,
    action: 'CREATE' | 'UPDATE' | 'CANCEL',
    summary: Record<string, unknown>,
  ): Promise<unknown> {
    return runWithTenant(tenantId, () =>
      this.audit.append(
        {
          tenantId,
          actorType: 'WX_USER',
          actorId: wxUserId,
          action,
          resourceType: 'HouseBinding',
          resourceId: bindingId,
          afterSummary: summary,
        },
        tx as never,
      ),
    );
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
