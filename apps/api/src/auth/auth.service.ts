import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode } from '@pf/shared';
import { AuditService } from '../audit/audit.service';
import { BindingSyncService } from '../binding/binding-sync.service';
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
    private readonly bindingSync: BindingSyncService,
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
   * - 精确规范化匹配 HouseContact.phone（房屋授权手机号列表），命中房屋建/复活 PHONE_MATCH 绑定；
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

    /*
     * 匹配路径已从 House.ownerPhone（单字段）换成 HouseContact（授权手机号列表）——
     * 一套房可以同时授权业主、家属、租客;物业删号即解绑（BindingSyncService）。
     *
     * 只匹配**在营物业公司**的房屋:
     * 2026-08-02 实测,业主授权后提示「已自动绑定 1 处房屋」而首页什么都没有 ——
     * 匹配到的房属于已停用租户,业主端把它过滤掉了。宣称已生效、实际没生效,
     * 而且发生在新业主进来的第一步。
     *
     * 同时按租户的渠道配置过滤:phoneMatch 关掉的物业公司不参与自动匹配
     * （缺配置行 = 默认开,见 DEFAULT_BINDING_CONFIG）。
     */
    const contacts = await this.prisma.raw.houseContact.findMany({
      where: {
        phone,
        house: {
          status: 'ACTIVE',
          community: {
            tenant: {
              status: 'ACTIVE',
              OR: [{ bindingConfig: { is: null } }, { bindingConfig: { phoneMatch: true } }],
            },
          },
        },
      },
      include: { house: { select: { id: true, tenantId: true, communityId: true, code: true } } },
    });
    // 同一套房可能有多行联系人(不同号)但 phone 精确匹配下 (houseId,phone) 唯一 → 房屋天然不重复
    const houses = contacts.map((c) => c.house);
    const matchedHouseIds = new Set(houses.map((h) => h.id));
    const existing = await this.prisma.raw.houseBinding.findMany({ where: { wxUserId } });

    await this.prisma.raw.$transaction(async (tx) => {
      // 1) 命中房屋：建立或复活 PHONE_MATCH 绑定（共享实现,绝不覆盖人工审批证据）。
      await this.bindingSync.applyPhoneMatch(tx, wxUserId, houses, now, { type: 'WX_USER', id: wxUserId });
      // 2) 失效的仅手机匹配绑定：手机号已变更/不再匹配 → 自动解绑，人工审批不受影响。
      //    （物业删号已在 BindingSyncService.revokeContact 同步撤销;这条降级为
      //      「用户自己换了微信手机号」的兜底,保形不动。）
      for (const b of existing) {
        if (b.source === 'PHONE_MATCH' && b.status === 'ACTIVE' && !matchedHouseIds.has(b.houseId)) {
          const upd = await tx.houseBinding.updateMany({
            where: { id: b.id, status: 'ACTIVE', source: 'PHONE_MATCH' },
            /*
             * 原因要说人话，而且要说准。
             *
             * 原文案「手机号变更，自动解除仅手机匹配绑定」有两处不对：
             *   · 不一定是手机号变了 —— 也可能是那套房不再登记这个号码、
             *     或者那家物业公司被停用了（2026-08-02 实测就是后者）
             *   · 「仅手机匹配绑定」是内部说法，业主看不懂
             * 而且业主端会把 revokeReason 标成「物业填写的原因」，
             * 但这条是系统自动做的，不是物业写的 —— 所以文案里要自己说清是自动解除。
             */
            data: {
              status: 'REJECTED',
              revokedAt: now,
              revokeReason: '系统自动解除：该房屋已不在您手机号的登记范围内',
            },
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
        tx,
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
/**
 * bcrypt 成本因子。
 *
 * 原先各处硬编码 10。提到 12 是 4 倍计算量（约 +200ms），管理端登录完全可接受，
 * 而离线爆破的代价同步提高 4 倍。抽成常量是为了避免「改了登录那处、漏了建号那处」
 * ——两处不一致时，新建的账号会用更弱的成本因子，而这种差异不会有任何报错。
 */
export const BCRYPT_COST = 12;

/**
 * 生成一次性初始口令。
 *
 * 用于超管重置租户管理员密码：不由超管自己指定口令，避免「超管长期知道每个租户
 * 管理员的密码」。取 crypto 随机而非 Math.random（后者不是密码学随机）。
 * 字符集去掉了容易看错的 0/O/1/l/I —— 这个口令要靠电话或纸条传给对方。
 */
export function generateInitialPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // 保证同时含字母与数字，满足 assertStrongPassword
  return `${out}7a`;
}

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
