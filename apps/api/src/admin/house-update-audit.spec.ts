import { HousesService } from './houses.controller';

/**
 * 改房屋必须留审计。
 *
 * 2026-08-04 实测:一套房的 displayName 被改成了「03-13」,而审计里一条 House 的
 * UPDATE 都找不到 —— 无从判断是界面写错了还是人手打的。而这一页能改的
 * 面积与放户日期**直接决定账单金额与出账月份**:
 * 「这户为什么突然多收了 500」只能靠这段历史回答。
 *
 * 同时钉住「只记真变了的字段」:全字段回写会让审计堆满假变更,
 * 真正改过面积那一次就淹在里面了。
 */

const BEFORE = {
  id: 'h1',
  tenantId: 't1',
  communityId: 'c1',
  code: 'A-1-101',
  displayName: '汪圩嘉测试房',
  area: '92.08',
  handoverDate: new Date('2026-08-03T00:00:00Z'),
  status: 'ACTIVE',
  ownerName: null,
  ownerPhone: null,
};

function make() {
  const rows: Record<string, unknown>[] = [];
  const prisma = {
    t: {
      house: {
        findFirst: jest.fn(async () => BEFORE),
        update: jest.fn(async () => ({ id: 'h1' })),
      },
    },
    raw: { $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({ house: { update: jest.fn(async () => ({ id: 'h1' })) } })) },
  };
  const audit = { append: jest.fn(async (r: Record<string, unknown>) => rows.push(r)) };
  const svc = new HousesService(prisma as never, audit as never, { assertMobile: jest.fn(), grantContact: jest.fn(async () => ({})), revokeContact: jest.fn(async () => ({ revokedBindings: [] })) } as never);
  return { svc, rows, prisma, audit };
}

it('改了显示名 → 记一条 UPDATE 审计,写清从什么改成什么', async () => {
  const { svc, rows } = make();
  await svc.update('h1', { displayName: '03-13' } as never, 'admin-1');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'UPDATE', resourceType: 'House', resourceId: 'h1' });
  expect(JSON.stringify(rows[0].beforeSummary)).toContain('汪圩嘉测试房');
  expect(JSON.stringify(rows[0].beforeSummary)).toContain('03-13');
});

it('改面积/放户日期同样留痕——它们直接决定金额与出账月份', async () => {
  const { svc, rows } = make();
  await svc.update('h1', { area: 100, handoverDate: '2026-09-01' } as never, 'admin-1');
  const s = JSON.stringify(rows[0]);
  expect(s).toContain('area');
  expect(s).toContain('handoverDate');
  expect(s).toContain('2026-09-01');
});

it('值没变就不写审计——假变更会把真变更淹掉', async () => {
  const { svc, rows } = make();
  await svc.update('h1', { displayName: '汪圩嘉测试房', area: 92.08 } as never, 'admin-1');
  expect(rows).toHaveLength(0);
});

it('手机号只记「改了没」,号码本身不进审计正文', async () => {
  const { svc, rows } = make();
  await svc.update('h1', { ownerPhone: '13800001111' } as never, 'admin-1');
  const s = JSON.stringify(rows[0] ?? {});
  expect(s).toContain('ownerPhoneChanged');
  expect(s).not.toContain('13800001111');
});
