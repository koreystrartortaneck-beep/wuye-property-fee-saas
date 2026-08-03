import { BindingSyncService, DEFAULT_BINDING_CONFIG } from './binding-sync.service';
import { BizException } from '../common/biz.exception';

/**
 * 绑定联动矩阵 —— 本次重构的核心行为。
 *
 * 修的 bug:后台改手机号完全不触碰绑定(自动解绑只在业主自己重新授权时跑),
 * 换租后前住户继续看得到现住户的账单。
 *
 * 现在的约定:
 *   加号 = 授权(已授权过手机号的用户当场绑上)
 *   删号 = 解绑(该房该号的全部 ACTIVE 绑定同事务撤销,**不分 source**)
 *   人工审批证据(APPLY/reviewedBy)绝不被手机匹配覆盖 —— 四个入口共用这一份规则
 */

const HOUSE = { id: 'h1', tenantId: 't1', communityId: 'c1', code: 'JGC-1-101' };
const ACTOR = { type: 'ADMIN' as const, id: 'admin1' };

function makeTx(opts: {
  users?: Array<{ id: string }>;
  bindings?: Array<Record<string, unknown>>;
  contactCreateError?: string;
  existingContact?: { id: string };
  deletedContacts?: number;
}) {
  const created: Record<string, unknown>[] = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const contactCreates: Record<string, unknown>[] = [];
  const tx = {
    houseContact: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.contactCreateError) {
          const e = new Error('dup') as Error & { code: string };
          e.code = opts.contactCreateError;
          throw e;
        }
        contactCreates.push(data);
        return { id: 'contact-1', ...data };
      }),
      findFirst: jest.fn(async () => opts.existingContact ?? null),
      deleteMany: jest.fn(async () => ({ count: opts.deletedContacts ?? 1 })),
    },
    wxUser: { findMany: jest.fn(async () => opts.users ?? []) },
    houseBinding: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const all = opts.bindings ?? [];
        // applyPhoneMatch 按 houseId in 查;revokeContact 按 status+wxUser.phone 查
        if ((where as { houseId?: { in?: string[] } }).houseId && typeof where.houseId === 'object') {
          return all.filter((b) => (where.houseId as { in: string[] }).in.includes(b.houseId as string));
        }
        return all.filter((b) => b.status === 'ACTIVE');
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'new-binding', ...data };
      }),
      updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
  };
  return { tx, created, updates, contactCreates };
}

function makeService(configRow: Record<string, unknown> | null = null) {
  const audits: Record<string, unknown>[] = [];
  const prisma = {
    raw: { tenantBindingConfig: { findUnique: jest.fn(async () => configRow) } },
  };
  const audit = {
    append: jest.fn(async (input: Record<string, unknown>) => {
      audits.push(input);
      return {};
    }),
  };
  return { service: new BindingSyncService(prisma as never, audit as never), audits };
}

describe('加号 = 授权', () => {
  it('号主还没用过小程序:只落联系人,不建绑定', async () => {
    const { service, audits } = makeService();
    const { tx, created } = makeTx({ users: [] });
    const r = await service.grantContact(tx as never, HOUSE, '13800001111', '张三', 'ADMIN', ACTOR);
    expect(r).toMatchObject({ created: true, activatedBindings: 0 });
    expect(created).toHaveLength(0);
    // 加号本身要留痕
    expect(audits.some((a) => JSON.stringify(a.afterSummary).includes('HOUSE_CONTACT_ADD'))).toBe(true);
  });

  it('号主已授权过手机号:当场建 ACTIVE 绑定,不等他下次打开', async () => {
    const { service } = makeService();
    const { tx, created } = makeTx({ users: [{ id: 'wx-1' }], bindings: [] });
    const r = await service.grantContact(tx as never, HOUSE, '13800001111', null, 'ADMIN', ACTOR);
    expect(r.activatedBindings).toBe(1);
    expect(created[0]).toMatchObject({ houseId: 'h1', wxUserId: 'wx-1', status: 'ACTIVE', source: 'PHONE_MATCH' });
  });

  it('审批联动加号(APPLY_APPROVED)幂等:已存在同号不报错、复用既有行', async () => {
    const { service, audits } = makeService();
    const { tx } = makeTx({ contactCreateError: 'P2002', existingContact: { id: 'old-contact' }, users: [] });
    const r = await service.grantContact(tx as never, HOUSE, '13800001111', null, 'APPLY_APPROVED', ACTOR);
    expect(r).toMatchObject({ created: false, contactId: 'old-contact' });
    // 没有新建就不该留「新增」痕迹
    expect(audits.filter((a) => JSON.stringify(a.afterSummary).includes('HOUSE_CONTACT_ADD'))).toHaveLength(0);
  });

  it('号主有被解除的旧 PHONE_MATCH 绑定:复活,不新建', async () => {
    const { service } = makeService();
    const stale = { id: 'b-old', houseId: 'h1', tenantId: 't1', status: 'REJECTED', source: 'PHONE_MATCH', reviewedBy: null, revokedAt: new Date() };
    const { tx, created, updates } = makeTx({ users: [{ id: 'wx-1' }], bindings: [stale] });
    const r = await service.grantContact(tx as never, HOUSE, '13800001111', null, 'ADMIN', ACTOR);
    expect(r.activatedBindings).toBe(1);
    expect(created).toHaveLength(0);
    expect(updates[0].data).toMatchObject({ status: 'ACTIVE', revokedAt: null, revokeReason: null });
  });

  it('号主有待审的 APPLY 申请:不动它——人工审批证据不被手机匹配覆盖', async () => {
    const { service } = makeService();
    const pending = { id: 'b-apply', houseId: 'h1', tenantId: 't1', status: 'PENDING', source: 'APPLY', reviewedBy: null, revokedAt: null };
    const { tx, created, updates } = makeTx({ users: [{ id: 'wx-1' }], bindings: [pending] });
    const r = await service.grantContact(tx as never, HOUSE, '13800001111', null, 'ADMIN', ACTOR);
    expect(r.activatedBindings).toBe(0);
    expect(created).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe('删号 = 解绑', () => {
  it('撤销该房该号的全部 ACTIVE 绑定,不分 source', async () => {
    /*
     * 「不分 source」自洽于「审批通过自动加号」:APPLY 出身的人,
     * 他的授权就是那行联系人 —— 删号就是收回授权,没有第二种解释。
     */
    const { service, audits } = makeService();
    const bindings = [
      { id: 'b1', wxUserId: 'wx-1', tenantId: 't1', status: 'ACTIVE', source: 'PHONE_MATCH' },
      { id: 'b2', wxUserId: 'wx-2', tenantId: 't1', status: 'ACTIVE', source: 'APPLY' },
    ];
    const { tx, updates } = makeTx({ bindings });
    const r = await service.revokeContact(tx as never, HOUSE, '13800001111', '物业已移除该房屋的联系人授权', ACTOR);

    expect(r.removedContact).toBe(true);
    expect(r.revoked).toEqual([
      { bindingId: 'b1', wxUserId: 'wx-1' },
      { bindingId: 'b2', wxUserId: 'wx-2' },
    ]);
    expect(updates[0].where).toMatchObject({ id: { in: ['b1', 'b2'] } });
    expect(updates[0].data).toMatchObject({ status: 'REJECTED', revokeReason: '物业已移除该房屋的联系人授权' });
    // 每条撤销 + 删号本身都留痕
    const events = audits.map((a) => JSON.stringify(a.afterSummary));
    expect(events.filter((e) => e.includes('BINDING_CONTACT_REMOVE_REVOKE'))).toHaveLength(2);
    expect(events.filter((e) => e.includes('HOUSE_CONTACT_REMOVE'))).toHaveLength(1);
  });

  it('没人绑着:删号成功、撤销列表为空——如实返回,不编造', async () => {
    const { service } = makeService();
    const { tx, updates } = makeTx({ bindings: [] });
    const r = await service.revokeContact(tx as never, HOUSE, '13800001111', 'x', ACTOR);
    expect(r).toEqual({ removedContact: true, revoked: [] });
    expect(updates).toHaveLength(0);
  });
});

describe('渠道配置', () => {
  it('缺行 = 全默认(全开、需审批)', async () => {
    const { service } = makeService(null);
    await expect(service.getConfig('t1')).resolves.toEqual(DEFAULT_BINDING_CONFIG);
  });

  it('有行按行', async () => {
    const { service } = makeService({ phoneMatch: false, selfApply: true, selfApplyNeedsApproval: false });
    await expect(service.getConfig('t1')).resolves.toEqual({
      phoneMatch: false,
      selfApply: true,
      selfApplyNeedsApproval: false,
    });
  });
});

describe('手机号校验', () => {
  it('只收 11 位大陆手机号——别的格式登记了也匹配不上,不如当场说清', () => {
    const { service } = makeService();
    expect(() => service.assertMobile('13800001111')).not.toThrow();
    for (const bad of ['0431-1234567', '138001111', '23800001111', 'abc']) {
      expect(() => service.assertMobile(bad)).toThrow(BizException);
    }
  });
});
