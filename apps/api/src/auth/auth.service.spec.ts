import { AuthService, maskPhone, normalizePhone } from './auth.service';
import { BindingSyncService } from '../binding/binding-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { WxApi } from '../wx/wx.service';

describe('AuthService 云托管身份', () => {
  it('提供可信 openid 时不调用 jscode2session', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 'user-id', phone: null, tokenVersion: 0 });
    const prisma = { raw: { wxUser: { upsert } } } as unknown as PrismaService;
    const jwt = { signAsync: jest.fn().mockResolvedValue('owner-token') };
    const wx = { code2session: jest.fn() } as unknown as WxApi;
    const audit = { append: jest.fn() };
    const bindingSync = new BindingSyncService(prisma as never, audit as never);
    const service = new AuthService(prisma, jwt as never, wx, audit as never, bindingSync);

    await expect(
      (service.wxLogin as unknown as (code: string, openid?: string) => Promise<unknown>)('unused-code', 'cloud-openid'),
    ).resolves.toEqual({ token: 'owner-token', user: { id: 'user-id', hasPhone: false } });

    expect(wx.code2session).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({
      where: { openid: 'cloud-openid' },
      create: { openid: 'cloud-openid' },
      update: {},
    });
    // 签发 owner 令牌携带 tokenVersion（用于吊销）
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-id', typ: 'owner', ver: 0 }),
      expect.anything(),
    );
  });
});

describe('工具函数', () => {
  it('normalizePhone 去空白与 +86 前缀', () => {
    expect(normalizePhone(' 138 0000 1111 ')).toBe('13800001111');
    expect(normalizePhone('+8613800001111')).toBe('13800001111');
  });
  it('maskPhone 仅保留前 3 后 4', () => {
    expect(maskPhone('13800001111')).toBe('138****1111');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('AuthService.bindPhone 证据感知绑定', () => {
  let audit: { append: jest.Mock };
  let wx: { getPhoneNumber: jest.Mock };

  beforeEach(() => {
    audit = { append: jest.fn().mockResolvedValue(undefined) };
    wx = { getPhoneNumber: jest.fn().mockResolvedValue({ phone: '13800001111' }) };
  });

  function makeTx(existing: Array<{ houseId: string }>) {
    return {
      houseBinding: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-b', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // applyPhoneMatch 在事务内查「该用户在命中房屋上的既有绑定」——按 houseId 过滤,和真库一致
        findMany: jest.fn(async ({ where }: { where: { houseId?: { in: string[] } } }) =>
          existing.filter((b) => !where.houseId || where.houseId.in.includes(b.houseId)),
        ),
      },
    };
  }

  /*
   * 匹配路径已换成 HouseContact:houses 参数在这里表达为「联系人行 + 所属房屋」。
   * BindingSyncService 用真实现(不 mock)—— 这组测试钉的正是它的匹配规则。
   */
  function makePrisma(houses: Array<{ id: string; tenantId: string }>, existing: Array<{ houseId: string }>, tx = makeTx(existing)) {
    return {
      prisma: {
        raw: {
          wxUser: { update: jest.fn().mockResolvedValue({}) },
          houseContact: {
            findMany: jest.fn().mockResolvedValue(
              houses.map((h) => ({ house: { ...h, communityId: null, code: null } })),
            ),
          },
          houseBinding: { findMany: jest.fn().mockResolvedValue(existing) },
          $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
        },
      },
      tx,
    };
  }

  function makeService(prisma: unknown): AuthService {
    const bindingSync = new BindingSyncService(prisma as never, audit as never);
    return new AuthService(prisma as never, { signAsync: jest.fn() } as never, wx as never, audit as never, bindingSync);
  }

  it('精确匹配房屋自动建立 PHONE_MATCH 绑定，返回掩码手机号', async () => {
    const { prisma, tx } = makePrisma([{ id: 'h1', tenantId: 't1' }], []);
    const service = makeService(prisma);

    const result = await service.bindPhone('wx-1', 'phone:x');

    expect(result).toEqual({ phone: '138****1111', matchedHouses: 1 });
    expect(tx.houseBinding.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ houseId: 'h1', source: 'PHONE_MATCH', status: 'ACTIVE' }) }),
    );
    expect(audit.append).toHaveBeenCalled();
  });

  it('不覆盖人工审批绑定（source=APPLY）', async () => {
    const existing = [{ id: 'b1', houseId: 'h1', tenantId: 't1', status: 'ACTIVE', source: 'APPLY', reviewedBy: 'admin-1', revokedAt: null }];
    const { prisma, tx } = makePrisma([{ id: 'h1', tenantId: 't1' }], existing);
    const service = makeService(prisma);

    await service.bindPhone('wx-1', 'phone:x');

    expect(tx.houseBinding.create).not.toHaveBeenCalled();
    expect(tx.houseBinding.updateMany).not.toHaveBeenCalled();
  });

  it('手机号不再匹配的旧 PHONE_MATCH 绑定被自动解除，人工审批保留', async () => {
    const existing = [
      { id: 'stale', houseId: 'h-old', tenantId: 't1', status: 'ACTIVE', source: 'PHONE_MATCH', reviewedBy: null, revokedAt: null },
      { id: 'manual', houseId: 'h-manual', tenantId: 't1', status: 'ACTIVE', source: 'APPLY', reviewedBy: 'admin-1', revokedAt: null },
    ];
    // 当前手机号仅匹配新房屋 h-new，不匹配 h-old
    const { prisma, tx } = makePrisma([{ id: 'h-new', tenantId: 't1' }], existing);
    const service = makeService(prisma);

    await service.bindPhone('wx-1', 'phone:x');

    // 旧 PHONE_MATCH 被撤销
    expect(tx.houseBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'stale', source: 'PHONE_MATCH' }),
        data: expect.objectContaining({ status: 'REJECTED', revokeReason: expect.any(String) }),
      }),
    );
    // 人工审批（manual）未被撤销
    const revokedIds = tx.houseBinding.updateMany.mock.calls.map((c) => c[0].where.id);
    expect(revokedIds).not.toContain('manual');
  });
});
