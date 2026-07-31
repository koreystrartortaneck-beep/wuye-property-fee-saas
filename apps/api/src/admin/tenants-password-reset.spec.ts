import * as bcrypt from 'bcryptjs';
import { TenantsService } from './tenants.controller';
import { BCRYPT_COST, assertStrongPassword, generateInitialPassword } from '../auth/auth.service';

/**
 * 超管重置租户管理员密码。
 *
 * 为什么这个端点必须存在：管理员忘记密码时，此前唯一的出路是直连数据库改哈希，
 * 或者用灰度期那个后门模块的 mkadmin —— 而 mkadmin 能造超管、绕过强口令校验、
 * 把 mustChangePassword 置 false、还不写任何审计。
 * **缺失的合法通道会长期把不安全的通道留在代码里**：先补上这条正路，那个后门才有底气删。
 *
 * 这个端点动的是账号凭据，所以每一条都做行为断言。
 */
describe('TenantsService 重置管理员密码', () => {
  const ADMIN = {
    id: 'a1',
    tenantId: 't1',
    username: 'gangcheng',
    role: 'TENANT_ADMIN',
    passwordHash: 'old-hash',
  };

  function makePrisma(admin: unknown = ADMIN) {
    const tx = {
      adminUser: { update: jest.fn().mockResolvedValue({}) },
    };
    return {
      raw: {
        adminUser: { findUnique: jest.fn().mockResolvedValue(admin) },
        $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
      },
      __tx: tx,
    };
  }

  function makeService(prisma: ReturnType<typeof makePrisma>) {
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    return { service: new TenantsService(prisma as never, audit as never), audit, tx: prisma.__tx };
  }

  it('返回一次性口令，且它满足强口令策略', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);
    const res = await service.resetAdminPassword('t1', 'a1', 'super-1');
    expect(res.username).toBe('gangcheng');
    expect(() => assertStrongPassword(res.password)).not.toThrow();
  });

  it('口令由服务端随机生成，两次不同（超管不该长期知道对方的密码）', async () => {
    const a = generateInitialPassword();
    const b = generateInitialPassword();
    expect(a).not.toBe(b);
    // 去掉了容易看错的字符：这个口令要靠电话或纸条传给对方
    expect(a).not.toMatch(/[0O1lI]/);
  });

  it('落库的是哈希且成本因子为 12，绝不存明文', async () => {
    const prisma = makePrisma();
    const { service, tx } = makeService(prisma);
    const res = await service.resetAdminPassword('t1', 'a1', 'super-1');

    const data = tx.adminUser.update.mock.calls[0][0].data;
    expect(data.passwordHash).not.toBe(res.password);
    expect(data.passwordHash.startsWith('$2')).toBe(true);
    /*
     * 断言字面值 12，而不是 String(BCRYPT_COST)。
     * 后者是自指断言：常量一改两边一起变，把成本因子退回 10 时测试照样全绿（实测）。
     * 这与本会话反复栽的「复刻式守卫」是同一类错——断言必须来自外部要求，
     * 而不是被测代码自己。
     */
    expect(data.passwordHash.split('$')[2]).toBe('12');
    // 哈希确实对应返回的口令
    expect(await bcrypt.compare(res.password, data.passwordHash)).toBe(true);
  });

  it('强制首次改密，并吊销该账号全部旧令牌', async () => {
    /*
     * mustChangePassword 此前是一条死控制：AdminGuard 早就实现了它，schema 也有字段，
     * 但没有任何代码路径会把它设为 true（默认 false，只有一次性迁移置过存量账号）。
     * tokenVersion +1 是因为「忘记密码」常伴随「怀疑号被别人用了」。
     */
    const prisma = makePrisma();
    const { service, tx } = makeService(prisma);
    await service.resetAdminPassword('t1', 'a1', 'super-1');

    const data = tx.adminUser.update.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(true);
    expect(data.tokenVersion).toEqual({ increment: 1 });
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
  });

  it('写审计，但绝不把口令写进审计', async () => {
    const prisma = makePrisma();
    const { service, audit } = makeService(prisma);
    const res = await service.resetAdminPassword('t1', 'a1', 'super-1');

    expect(audit.append).toHaveBeenCalledTimes(1);
    const entry = audit.append.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorType: 'ADMIN',
      actorId: 'super-1',
      resourceType: 'AdminUser',
      resourceId: 'a1',
    });
    expect(JSON.stringify(entry)).not.toContain(res.password);
  });

  it('审计与改密在同一事务内（一个成一个不成会让审计链断掉）', async () => {
    const prisma = makePrisma();
    const { service, audit } = makeService(prisma);
    await service.resetAdminPassword('t1', 'a1', 'super-1');
    // 第二个参数是事务客户端
    expect(audit.append.mock.calls[0][1]).toBe(prisma.__tx);
  });

  it('跨租户拒绝：不能重置别的租户下的管理员', async () => {
    const prisma = makePrisma({ ...ADMIN, tenantId: 'OTHER' });
    const { service, tx } = makeService(prisma);
    await expect(service.resetAdminPassword('t1', 'a1', 'super-1')).rejects.toMatchObject({ code: 40400 });
    expect(tx.adminUser.update).not.toHaveBeenCalled();
  });

  it('账号不存在时拒绝', async () => {
    const prisma = makePrisma(null);
    const { service } = makeService(prisma);
    await expect(service.resetAdminPassword('t1', 'nope', 'super-1')).rejects.toMatchObject({ code: 40400 });
  });

  it('不能通过租户入口重置超管（它没有租户维度）', async () => {
    const prisma = makePrisma({ ...ADMIN, role: 'SUPER_ADMIN' });
    const { service, tx } = makeService(prisma);
    await expect(service.resetAdminPassword('t1', 'a1', 'super-1')).rejects.toMatchObject({ code: 40300 });
    expect(tx.adminUser.update).not.toHaveBeenCalled();
  });
});

describe('新建租户管理员必须强制首次改密', () => {
  it('create 时置 mustChangePassword，且哈希成本因子为 12', async () => {
    /*
     * 原实现不设这个字段（默认 false），于是超管指定的初始密码会一直用下去 ——
     * 超管长期知道每个租户管理员的密码。
     */
    const tx = {
      tenant: { create: jest.fn().mockResolvedValue({ id: 't-new', name: '某物业' }) },
      adminUser: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      raw: {
        tenant: { findUnique: jest.fn().mockResolvedValue(null) },
        adminUser: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
      },
    };
    const service = new TenantsService(prisma as never, { append: jest.fn() } as never);
    await service.create({
      name: '某物业',
      code: 'X1',
      contactName: '张三',
      contactPhone: '13800000000',
      adminUsername: 'x1admin',
      adminPassword: 'Abcdefgh1234',
    } as never);

    const data = tx.adminUser.create.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(true);
    expect(data.passwordHash.split('$')[2]).toBe('12');
  });

  it('成本因子常量不低于 12（原先各处硬编码 10）', () => {
    /*
     * 12 是 10 的 4 倍计算量（约 +200ms），管理端登录完全可接受，而离线爆破代价同步
     * 提高 4 倍。抽成常量是为了避免「改了登录那处、漏了建号那处」——两处不一致时
     * 新建账号会用更弱的成本因子，而这种差异不会有任何报错。
     */
    expect(BCRYPT_COST).toBeGreaterThanOrEqual(12);
  });
});

describe('创建只读平台账号', () => {
  /*
   * 没有这个入口的话 PLATFORM_READONLY 只是一个枚举值——角色实现了但没人能拥有它，
   * 平台侧看数据仍然只能动用全权超管。这与「后门长期存在是因为缺少合法通道」
   * 是同一类问题：能力和入口必须一起给。
   */
  function make(existing: unknown = null) {
    // 不再用事务：只有一次 create，且不写 AuditLog（见下方用例的理由）
    const tx = {
      adminUser: { create: jest.fn().mockResolvedValue({ id: 'ro-1' }) },
    };
    const prisma = {
      raw: {
        adminUser: {
          findUnique: jest.fn().mockResolvedValue(existing),
          create: tx.adminUser.create,
        },
        $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
      },
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    return { service: new TenantsService(prisma as never, audit as never), tx, audit };
  }

  it('落库角色是 PLATFORM_READONLY，且 tenantId 为 null（平台账号不属于任何租户）', async () => {
    const { service, tx } = make();
    await service.createPlatformReadonly('platform-ro', '平台只读', 'super-1');
    const data = tx.adminUser.create.mock.calls[0][0].data;
    expect(data.role).toBe('PLATFORM_READONLY');
    /*
     * tenantId 必须是 null。若落到某个租户下，AdminGuard 会用 payload.tenantId 而不是
     * X-Tenant-Id，这个账号就只能看那一个租户——「平台只读」名不副实。
     */
    expect(data.tenantId).toBeNull();
  });

  it('强制首次改密，口令由服务端生成且满足强口令策略', async () => {
    const { service, tx } = make();
    const res = await service.createPlatformReadonly('platform-ro', '平台只读', 'super-1');
    const data = tx.adminUser.create.mock.calls[0][0].data;
    expect(data.mustChangePassword).toBe(true);
    expect(() => assertStrongPassword(res.password)).not.toThrow();
    expect(data.passwordHash.split('$')[2]).toBe('12');
    expect(await bcrypt.compare(res.password, data.passwordHash)).toBe(true);
  });

  it('不写 AuditLog（该表要求 tenantId 非空，平台动作没有租户维度）', async () => {
    /*
     * AuditLog.tenantId 是 NOT NULL，且 assertTenantAccess 会校验它与当前租户上下文
     * 一致——这是审计表的设计前提（DB 层还有 append-only 触发器与 ON DELETE RESTRICT
     * 外键）。硬塞一个租户 ID 会让那个租户的审计流里出现一条与它无关的记录，比不写更糟。
     * 平台级审计需要一张独立的表，那是另一件事。
     */
    const { service, audit } = make();
    await service.createPlatformReadonly('platform-ro', '平台只读', 'super-1');
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('账号名重复时拒绝，不创建', async () => {
    const { service, tx } = make({ id: 'exists' });
    await expect(service.createPlatformReadonly('dup', '重复', 'super-1')).rejects.toMatchObject({ code: 40000 });
    expect(tx.adminUser.create).not.toHaveBeenCalled();
  });
});
