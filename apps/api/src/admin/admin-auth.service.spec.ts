import * as bcrypt from 'bcryptjs';
import { AdminAuthService } from './admin-auth.controller';
import { BizException } from '../common/biz.exception';

function makeAdmin(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'a1',
    tenantId: 't1',
    username: 'boss',
    passwordHash: bcrypt.hashSync('Sup3rStrongPass!', 10),
    name: '物业管理员',
    role: 'TENANT_ADMIN',
    status: 'ACTIVE',
    failedLoginCount: 0,
    lockedUntil: null,
    tokenVersion: 3,
    mustChangePassword: false,
    ...over,
  };
}

function setup(admin: Record<string, unknown> | null) {
  const state = { admin };
  const prisma = {
    raw: {
      adminUser: {
        findUnique: jest.fn(async () => state.admin),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          state.admin = { ...(state.admin as object), ...data };
          if ((data as { tokenVersion?: { increment: number } }).tokenVersion?.increment) {
            (state.admin as { tokenVersion: number }).tokenVersion =
              ((admin as { tokenVersion: number }).tokenVersion ?? 0) +
              (data as { tokenVersion: { increment: number } }).tokenVersion.increment;
          }
          return state.admin;
        }),
      },
    },
  };
  const auth = { signAdminToken: jest.fn(async (p: unknown) => `tok:${JSON.stringify(p)}`) };
  const svc = new AdminAuthService(prisma as never, auth as never);
  return { svc, prisma, auth, state };
}

describe('AdminAuthService 会话加固', () => {
  it('正确口令登录成功、清零失败计数、令牌带 tokenVersion', async () => {
    const { svc, auth } = setup(makeAdmin({ failedLoginCount: 2 }));
    const r = await svc.login('boss', 'Sup3rStrongPass!', '1.1.1.1');
    expect(r.token).toContain('tok:');
    expect(auth.signAdminToken).toHaveBeenCalledWith(expect.objectContaining({ sub: 'a1', ver: 3 }));
    expect(r.mustChangePassword).toBe(false);
  });

  it('口令错误递增失败计数；第 5 次锁定', async () => {
    const { svc, state } = setup(makeAdmin({ failedLoginCount: 4 }));
    await expect(svc.login('boss', 'wrong', 'ip')).rejects.toBeInstanceOf(BizException);
    expect((state.admin as { lockedUntil: Date | null }).lockedUntil).toBeInstanceOf(Date);
  });

  it('锁定期内直接拒绝', async () => {
    const { svc } = setup(makeAdmin({ lockedUntil: new Date(Date.now() + 60_000) }));
    await expect(svc.login('boss', 'Sup3rStrongPass!', 'ip')).rejects.toThrow('锁定');
  });

  it('禁用账号用中性错误拒绝（不暴露账号存在）', async () => {
    const { svc } = setup(makeAdmin({ status: 'DISABLED' }));
    await expect(svc.login('boss', 'Sup3rStrongPass!', 'ip')).rejects.toThrow('用户名或密码错误');
  });

  it('账号不存在与口令错误返回同一中性错误', async () => {
    const a = setup(null);
    await expect(a.svc.login('ghost', 'x', 'ip')).rejects.toThrow('用户名或密码错误');
    const b = setup(makeAdmin());
    await expect(b.svc.login('boss', 'wrong', 'ip')).rejects.toThrow('用户名或密码错误');
  });

  it('改密：弱口令拒绝', async () => {
    const { svc } = setup(makeAdmin());
    await expect(svc.changePassword('a1', 'Sup3rStrongPass!', 'short1')).rejects.toThrow('至少 12 位');
  });

  it('改密：与原密码相同拒绝', async () => {
    const { svc } = setup(makeAdmin());
    await expect(svc.changePassword('a1', 'Sup3rStrongPass!', 'Sup3rStrongPass!')).rejects.toThrow('不能与原密码相同');
  });

  it('改密成功：tokenVersion 递增、清除 mustChangePassword', async () => {
    const { svc, state } = setup(makeAdmin({ mustChangePassword: true }));
    const r = await svc.changePassword('a1', 'Sup3rStrongPass!', 'An0therStrongPass');
    expect(r.token).toContain('tok:');
    expect((state.admin as { tokenVersion: number }).tokenVersion).toBe(4);
    expect((state.admin as { mustChangePassword: boolean }).mustChangePassword).toBe(false);
  });
});
