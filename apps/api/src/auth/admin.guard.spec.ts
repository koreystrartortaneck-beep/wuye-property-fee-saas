import { ErrorCode } from '@pf/shared';
import { AdminGuard } from './admin.guard';

/**
 * 管理端守卫。按覆盖率找过来的 —— 这个文件原本只有 26%，是全仓最低的之一，
 * 而它是鉴权边界：这里出错比金额出错更严重。
 *
 * 两个真问题：
 *
 * ① X-Tenant-Id 从不校验存在性。选了一个已删除（或本地缓存过期）的物业公司之后，
 *    prisma.t 会按一个不存在的 tenantId 过滤 —— **整个后台静默全空**。
 *    没有报错、没有提示，运营只看到「什么数据都没有」，想不到是视角选错了。
 *
 * ② mustChangePassword 的放行判据是 `path.includes('/admin/auth/change-password')`。
 *    req.path 取不到时回退的 req.url 带查询串，
 *    `/admin/tenants?next=/admin/auth/change-password` 就会被放行。
 *    Express 下 req.path 始终有值，所以这不是已存在的漏洞 ——
 *    但一个「靠上游恰好总有值」才安全的判据，不该留在鉴权路径里。
 */

type AdminRow = {
  tokenVersion: number;
  status: string;
  mustChangePassword: boolean;
};

function makeGuard(opts: {
  payload?: Record<string, unknown>;
  admin?: AdminRow | null;
  tenant?: { id: string } | null;
}) {
  const payload = {
    typ: 'admin',
    sub: 'a1',
    ver: 1,
    role: 'TENANT_ADMIN',
    tenantId: 't1',
    ...opts.payload,
  };
  const auth = { verifyToken: jest.fn(async () => payload) };
  const tenantFindUnique = jest.fn(async () => (opts.tenant === undefined ? { id: 't-x' } : opts.tenant));
  const prisma = {
    raw: {
      adminUser: {
        findUnique: jest.fn(async () =>
          opts.admin === undefined
            ? { tokenVersion: 1, status: 'ACTIVE', mustChangePassword: false }
            : opts.admin,
        ),
      },
      tenant: { findUnique: tenantFindUnique },
    },
  };
  return {
    guard: new AdminGuard(auth as never, prisma as never),
    tenantFindUnique,
  };
}

function ctxFor(headers: Record<string, string>, path = '/api/v1/admin/tickets', url?: string) {
  const req: Record<string, unknown> = { headers: { authorization: 'Bearer x', ...headers }, path, url: url ?? path };
  return {
    req,
    ctx: { switchToHttp: () => ({ getRequest: () => req }) } as never,
  };
}

describe('租户视角必须是真实存在的公司', () => {
  it('平台账号带合法 X-Tenant-Id → 注入该租户', async () => {
    const { guard } = makeGuard({ payload: { role: 'SUPER_ADMIN', tenantId: null }, tenant: { id: 't-x' } });
    const { ctx, req } = ctxFor({ 'x-tenant-id': 't-x' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((req.current as { tenantId: string }).tenantId).toBe('t-x');
  });

  it('租户不存在 → 报专门的错误码，不是让后台静默全空', async () => {
    /*
     * 用专门的码（40401）而不是 40400：前端据此清掉本地选中的租户、切回平台视角。
     * 复用 40400 就分不清「这条记录没有」和「你的视角选错了」。
     */
    const { guard } = makeGuard({ payload: { role: 'SUPER_ADMIN', tenantId: null }, tenant: null });
    const { ctx } = ctxFor({ 'x-tenant-id': 't-gone' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: ErrorCode.TENANT_VIEW_INVALID.code,
    });
  });

  it('不带 X-Tenant-Id 时是平台视角，且不白查一次数据库', async () => {
    const { guard, tenantFindUnique } = makeGuard({ payload: { role: 'SUPER_ADMIN', tenantId: null } });
    const { ctx, req } = ctxFor({});
    await guard.canActivate(ctx);
    expect((req.current as { tenantId: string | null }).tenantId).toBeNull();
    expect(tenantFindUnique).not.toHaveBeenCalled();
  });

  it('只读平台账号与超管享有同样的视角切换能力', async () => {
    // 运营数据是租户内的，只读账号不带租户视角就打不开运维页
    const { guard } = makeGuard({ payload: { role: 'PLATFORM_READONLY', tenantId: null }, tenant: { id: 't-x' } });
    const { ctx, req } = ctxFor({ 'x-tenant-id': 't-x' });
    await guard.canActivate(ctx);
    expect((req.current as { tenantId: string }).tenantId).toBe('t-x');
  });

  it('租户管理员的 X-Tenant-Id 被忽略——不能靠加个头跨租户', async () => {
    /*
     * 这是最要紧的一条：普通管理员只能看自己公司的数据，
     * 若这个头对它也生效，加一个 header 就能读别家公司的账单与手机号。
     */
    const { guard, tenantFindUnique } = makeGuard({
      payload: { role: 'TENANT_ADMIN', tenantId: 't1' },
      tenant: { id: 't-other' },
    });
    const { ctx, req } = ctxFor({ 'x-tenant-id': 't-other' });
    await guard.canActivate(ctx);
    expect((req.current as { tenantId: string }).tenantId).toBe('t1');
    expect(tenantFindUnique).not.toHaveBeenCalled();
  });
});

describe('会话有效性', () => {
  it('tokenVersion 不一致 → 拒绝（吊销生效）', async () => {
    const { guard } = makeGuard({ admin: { tokenVersion: 2, status: 'ACTIVE', mustChangePassword: false } });
    const { ctx } = ctxFor({});
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
  });

  it('账号被停用 → 拒绝', async () => {
    const { guard } = makeGuard({ admin: { tokenVersion: 1, status: 'DISABLED', mustChangePassword: false } });
    const { ctx } = ctxFor({});
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
  });

  it('账号不存在 → 拒绝', async () => {
    const { guard } = makeGuard({ admin: null });
    const { ctx } = ctxFor({});
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
  });

  it('业主令牌不能用在管理端', async () => {
    const { guard } = makeGuard({ payload: { typ: 'owner' } });
    const { ctx } = ctxFor({});
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
  });

  it('没有 Authorization 头 → 拒绝', async () => {
    const { guard } = makeGuard({});
    const req: Record<string, unknown> = { headers: {}, path: '/api/v1/admin/tickets' };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
  });
});

describe('强制改密的受限会话', () => {
  const mustChange: AdminRow = { tokenVersion: 1, status: 'ACTIVE', mustChangePassword: true };

  it('只放行改密端点', async () => {
    const { guard } = makeGuard({ admin: mustChange });
    const { ctx } = ctxFor({}, '/api/v1/admin/auth/change-password');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('其它端点一律拒绝', async () => {
    const { guard } = makeGuard({ admin: mustChange });
    const { ctx } = ctxFor({}, '/api/v1/admin/tenants');
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
  });

  it('把改密路径塞进查询串不能绕过', async () => {
    /*
     * 原判据是 includes：req.path 取不到时回退的 req.url 带查询串，
     * `?next=/admin/auth/change-password` 就会被放行。
     * 这里把 path 置空来模拟那个回退分支 —— 判据必须按路径部分精确匹配。
     */
    const { guard } = makeGuard({ admin: mustChange });
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer x' },
      path: '',
      url: '/api/v1/admin/tenants?next=/admin/auth/change-password',
    };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
  });
});
