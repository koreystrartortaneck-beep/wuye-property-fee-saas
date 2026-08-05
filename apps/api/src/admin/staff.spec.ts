import { StaffService } from './staff.controller';
import { BizException } from '../common/biz.exception';

/**
 * 员工账号与权限。
 *
 * 这个模块存在的理由:在它之前整个公司只有一个能用的管理账号,而 AdminUser.phone
 * 是唯一的 —— 也就是只有一个人能用手机进管理端。收费员上岗没入口,
 * 离职更没有:他的手机号一直在名单里,换了工作照样能看全小区欠费、给业主退款。
 *
 * 所以这里钉的不是「功能能用」,而是三类**不该做得出来的状态**:
 *   ① 把自己关在门外(停用/降级自己)
 *   ② 把公司搞成没有管理员(拿掉最后一个在职管理员)
 *   ③ 降级/停用之后旧令牌还能用满 12 小时
 * 前两条一旦发生,恢复要动数据库;第三条会让「已经取消他的权限」变成一句空话。
 */

const ME = { adminId: 'me', tenantId: 't1', role: 'TENANT_ADMIN' } as never;

function make(rows: Array<Record<string, unknown>>) {
  const audits: Record<string, unknown>[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const activeOtherAdmins = (exceptId: string) =>
    rows.filter((r) => r.role === 'TENANT_ADMIN' && r.status === 'ACTIVE' && r.id !== exceptId);
  const prisma = {
    raw: {
      // 事务桩:把 tx 指到同一批表,并让 FOR UPDATE 那条查询返回「其它在职管理员」
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({
          adminUser: prismaRef.raw.adminUser,
          $queryRaw: jest.fn(async (_sql: unknown, ...vals: unknown[]) =>
            activeOtherAdmins(String(vals[vals.length - 1])),
          ),
        }),
      ),
      adminUser: {
        findMany: jest.fn(async () => rows),
        findUnique: jest.fn(async ({ where }: { where: { id?: string; username?: string } }) =>
          where.id ? (byId.get(where.id) ?? null) : (rows.find((r) => r.username === where.username) ?? null),
        ),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new-1', ...data })),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, ...data });
          return { id: where.id };
        }),
        count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter(
            (r) =>
              r.role === 'TENANT_ADMIN' &&
              r.status === 'ACTIVE' &&
              r.id !== ((where.id as { not?: string })?.not ?? null),
          ).length,
        ),
      },
    },
  };
  const prismaRef: { raw: { adminUser: Record<string, jest.Mock> } } = prisma as never;
  const audit = { append: jest.fn(async (a: Record<string, unknown>) => audits.push(a)) };
  return { svc: new StaffService(prisma as never, audit as never), audits, updates, prisma };
}

const admin = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  tenantId: 't1',
  username: id,
  name: id,
  role: 'TENANT_ADMIN',
  status: 'ACTIVE',
  phone: null,
  mustChangePassword: false,
  lockedUntil: null,
  ...over,
});

describe('员工名单', () => {
  it('只给手机号尾 4 位,并如实说清「能不能用手机登录」', async () => {
    const { svc } = make([
      admin('a1', { phone: '13800001111' }),
      admin('a2', { role: 'STAFF', phone: '13900002222', mustChangePassword: true }),
    ]);
    const r = await svc.list(ME);
    expect(r.items[0].phoneTail).toBe('1111');
    expect(JSON.stringify(r.items)).not.toContain('13800001111');
    expect(r.items[0].canPhoneLogin).toBe(true);
    // 还没首次改密 → 免密通道会拒(受限会话),名单上必须看得出来
    expect(r.items[1].canPhoneLogin).toBe(false);
    expect(r.items[1].roleLabel).toBe('收费员');
  });
});

describe('新建员工', () => {
  it('口令服务端生成、只返回一次、强制首次改密;审计只留尾 4 位', async () => {
    const { svc, audits } = make([]);
    const r = await svc.create(ME, { username: 'shoufei', name: '王收费', role: 'STAFF', phone: '13900002222' } as never);
    expect(r.password).toBeTruthy();
    expect(r.needsFirstLogin).toBe(true);
    const s = JSON.stringify(audits[0]);
    expect(s).toContain('STAFF_CREATE');
    expect(s).toContain('2222');
    expect(s).not.toContain('13900002222'); // 全号绝不进审计
    expect(s).not.toContain(r.password); // 口令绝不进审计
  });

  it('登录名重复 → 明确拒绝', async () => {
    const { svc } = make([admin('shoufei', { username: 'shoufei' })]);
    await expect(
      svc.create(ME, { username: 'shoufei', name: '重名', role: 'STAFF' } as never),
    ).rejects.toThrow(/已被占用/);
  });

  it('手机号被别人占了 → 说清是手机号冲突,不是「服务器错误」', async () => {
    const { svc, prisma } = make([]);
    prisma.raw.adminUser.create = jest.fn(async (_args: { data: Record<string, unknown> }) => {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }) as typeof prisma.raw.adminUser.create;
    await expect(
      svc.create(ME, { username: 'x', name: 'x', role: 'STAFF', phone: '13900002222' } as never),
    ).rejects.toThrow(/已经登记在另一个账号上/);
  });
});

describe('不该做得出来的状态', () => {
  it('不能停用自己——手滑一次就把自己关在门外,恢复要动数据库', async () => {
    const { svc, updates } = make([admin('me'), admin('a2')]);
    await expect(svc.update(ME, 'me', { status: 'DISABLED' } as never)).rejects.toThrow(/不能停用或降级自己/);
    expect(updates).toHaveLength(0);
  });

  it('不能把自己降成收费员', async () => {
    const { svc } = make([admin('me'), admin('a2')]);
    await expect(svc.update(ME, 'me', { role: 'STAFF' } as never)).rejects.toThrow(/不能停用或降级自己/);
  });

  it('不能拿掉最后一个在职管理员——那样公司里没人能管员工、退款、发布账单', async () => {
    // 只有 other 一个在职管理员(me 已停用),再停它就没人了
    const { svc } = make([admin('me', { status: 'DISABLED' }), admin('other')]);
    await expect(svc.update(ME, 'other', { status: 'DISABLED' } as never)).rejects.toThrow(/最后一个在职管理员/);
  });

  it('还有别的管理员在职时,停用一个是允许的', async () => {
    const { svc, updates } = make([admin('me'), admin('other')]);
    await svc.update(ME, 'other', { status: 'DISABLED' } as never);
    expect(updates[0]).toMatchObject({ id: 'other', status: 'DISABLED' });
  });

  it('别家公司的账号一律 NOT_FOUND(而不是「无权」——不确认它存在)', async () => {
    const { svc } = make([admin('a2', { tenantId: 't9' })]);
    await expect(svc.update(ME, 'a2', { name: 'x' } as never)).rejects.toThrow(BizException);
  });
});

describe('权限变更要立刻生效', () => {
  it('降级/停用都要顶掉旧令牌——否则「已取消权限」是空话', async () => {
    const { svc, updates } = make([admin('me'), admine()]);
    await svc.update(ME, 'a2', { role: 'STAFF' } as never);
    /*
     * 不加 tokenVersion 的话:刚被降级的收费员手里那张管理员令牌还能用满 12 小时,
     * 而「降级」这个动作在他看来什么也没发生。
     */
    expect(updates[0]).toMatchObject({ role: 'STAFF', tokenVersion: { increment: 1 } });
  });

  it('只改名字不动令牌——那不是权限变更,没必要把人踢下线', async () => {
    const { svc, updates } = make([admin('me'), admine()]);
    await svc.update(ME, 'a2', { name: '新名字' } as never);
    expect(updates[0].tokenVersion).toBeUndefined();
  });

  it('重置密码也顶掉旧令牌(常见场景就是手机丢了/人已离职),且口令不入审计', async () => {
    const { svc, updates, audits } = make([admin('me'), admine()]);
    const r = await svc.resetPassword(ME, 'a2');
    expect(r.password).toBeTruthy();
    expect(updates[0]).toMatchObject({ mustChangePassword: true, tokenVersion: { increment: 1 } });
    expect(JSON.stringify(audits[0])).not.toContain(r.password);
  });
});

/** 另一位在职管理员 */
function admine() {
  return admin('a2');
}

it('「最后一个管理员」的检查必须锁行,而且与写在同一个事务里', async () => {
  /*
   * 只 count 一次再写是个真竞态:两位管理员同时停用彼此,两边都看到「还有另一个
   * 在职」→ 双双通过 → 公司里一个管理员都不剩,恢复要动数据库。
   * 这条断言 FOR UPDATE 真的发出去了,且发生在事务内。
   */
  const { svc, prisma } = make([admin('me'), admin('other')]);
  const seen: string[] = [];
  prisma.raw.$transaction = jest.fn(async (cb: (tx: unknown) => unknown) =>
    cb({
      adminUser: prisma.raw.adminUser,
      $queryRaw: jest.fn(async (sql: unknown) => {
        seen.push(String(sql));
        return [{ id: 'me' }];
      }),
    }),
  ) as typeof prisma.raw.$transaction;
  await svc.update(ME, 'other', { status: 'DISABLED' } as never);
  expect(prisma.raw.$transaction).toHaveBeenCalled();
  expect(seen.join(' ')).toMatch(/FOR UPDATE/);
});
