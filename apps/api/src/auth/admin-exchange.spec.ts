import { AuthController } from './auth.controller';

/**
 * 业主令牌 → 管理员令牌(小程序管理端免密登录)。
 *
 * 这是一个**权限授予点**:通过 = 拿到退款、解绑、看全体业主数据的能力。
 * 凭据是微信授权手机号(运营商核验的本人号码,等同短信验证码登录强度),
 * 但每一条拒绝路径都必须严:漏掉任何一条,就是把管理权发给不该有的人。
 *
 * 静默调用的约定:不是管理员返回 { admin: null },**不是错误** ——
 * 每个业主每次打开小程序都会探一次,报错会把正常用户的日志刷爆。
 */

function makeController(opts: {
  userPhone?: string | null;
  admin?: Record<string, unknown> | null;
  tenantStatus?: string;
}) {
  const audits: Record<string, unknown>[] = [];
  const prisma = {
    raw: {
      wxUser: { findUnique: jest.fn(async () => (opts.userPhone === undefined ? null : { id: 'wx-1', phone: opts.userPhone })) },
      adminUser: { findUnique: jest.fn(async () => opts.admin ?? null) },
      tenant: { findUnique: jest.fn(async () => ({ status: opts.tenantStatus ?? 'ACTIVE' })) },
    },
  };
  const signed: Record<string, unknown>[] = [];
  const auth = {
    signAdminToken: jest.fn(async (payload: Record<string, unknown>) => {
      signed.push(payload);
      return 'admin-jwt';
    }),
  };
  const audit = { append: jest.fn(async (i: Record<string, unknown>) => audits.push(i)) };
  const c = new AuthController(auth as never, prisma as never, audit as never);
  return { c, audits, auth, signed };
}

const ADMIN = {
  id: 'a1',
  tenantId: 't1',
  name: '物业经理',
  role: 'TENANT_ADMIN',
  status: 'ACTIVE',
  tokenVersion: 3,
  mustChangePassword: false,
};

const CUR = { ownerId: 'wx-1' } as never;

test('手机号匹配在营租户的在职管理员 → 换发令牌,角色随行,审计留痕', async () => {
  const { c, audits, auth } = makeController({ userPhone: '13800001111', admin: ADMIN });
  const r = await c.adminExchange(CUR);
  expect(r).toEqual({ admin: { name: '物业经理', role: 'TENANT_ADMIN', token: 'admin-jwt' } });
  // 令牌必须带 tokenVersion:改密/吊销后旧令牌立即失效的机制不能被免密通道绕开
  expect(auth.signAdminToken).toHaveBeenCalledWith({ sub: 'a1', tenantId: 't1', role: 'TENANT_ADMIN', ver: 3, pv: true });
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits[0].afterSummary)).toContain('ADMIN_PHONE_LOGIN');
});

test('普通业主(号码不在管理员名单)→ admin:null,不报错、不留审计', async () => {
  const { c, audits } = makeController({ userPhone: '13800001111', admin: null });
  await expect(c.adminExchange(CUR)).resolves.toEqual({ admin: null });
  expect(audits).toHaveLength(0); // 静默探测是噪音,不记
});

test.each([
  ['没授权过手机号', { userPhone: null, admin: ADMIN }],
  ['管理员已停用', { userPhone: '13800001111', admin: { ...ADMIN, status: 'DISABLED' } }],
  ['租户已停用', { userPhone: '13800001111', admin: ADMIN, tenantStatus: 'DISABLED' }],
])('%s → admin:null', async (_name, opts) => {
  const { c } = makeController(opts as never);
  await expect(c.adminExchange(CUR)).resolves.toEqual({ admin: null });
});

test('待首次改密**不拦**手机通道,且令牌带 pv 标记', async () => {
  /*
   * 「须先改初始密码」是密码通道的卫生要求(初始密码创建者见过)。
   * 手机通道的身份证明是运营商核验的手机号持有,与密码状态无关 ——
   * 拦它的实际后果:物业加了员工填了号,对方手机上永远看不到「物业工作」,
   * 唯一解法是去找一台电脑(2026-08-05 用户真机撞上)。
   * pv 标记是 AdminGuard 对受限会话放行的依据,少了它换发成功也全被 403。
   */
  const { c, signed } = makeController({ userPhone: '13800001111', admin: { ...ADMIN, mustChangePassword: true } });
  const r = await c.adminExchange(CUR);
  expect(r.admin).toMatchObject({ role: ADMIN.role });
  expect(signed[0]).toMatchObject({ pv: true });
});

test('平台级账号(tenantId=null)不查租户状态也能换发——但仍走全部其他关卡', async () => {
  /*
   * PLATFORM_READONLY 这类平台账号没有租户。它的只读约束由 RolesGuard
   * 按 HTTP 方法强制,与令牌来源无关 —— 免密通道不需要额外处理。
   */
  const { c } = makeController({ userPhone: '13800001111', admin: { ...ADMIN, tenantId: null, role: 'PLATFORM_READONLY' } });
  const r = await c.adminExchange(CUR);
  expect(r.admin).toMatchObject({ role: 'PLATFORM_READONLY' });
});
