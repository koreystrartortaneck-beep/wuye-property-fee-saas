import { OwnerHousesService } from './owner-houses.controller';
import { BizException } from '../common/biz.exception';

/**
 * 绑定渠道门 —— 服务端强制,小程序 UI 只是跟着显隐。
 *
 * UI 隐藏入口拦不住直接调接口的人;开关的意义只有在服务端也拒绝时才成立。
 * 免审批模式(selfApplyNeedsApproval=false)是「申请即生效」:
 * 与人工审批走同一条 grantContact 路径,用户手机号自动进授权名单。
 */

const HOUSE = { id: 'h1', tenantId: 't1', communityId: 'c1', code: 'JGC-1-101', status: 'ACTIVE' };

function makeService(config: { selfApply: boolean; selfApplyNeedsApproval: boolean }, userPhone: string | null = '13800001111') {
  const bindingCreates: Record<string, unknown>[] = [];
  const grants: unknown[] = [];
  const audits: Record<string, unknown>[] = [];
  const prisma = {
    raw: {
      house: { findUnique: jest.fn(async () => HOUSE) },
      houseBinding: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          bindingCreates.push(data);
          return { id: 'b-new', ...data };
        }),
      },
      wxUser: { findUnique: jest.fn(async () => (userPhone ? { phone: userPhone } : { phone: null })) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({})),
    },
  };
  const bindingSync = {
    getConfig: jest.fn(async () => ({ phoneMatch: true, ...config })),
    grantContact: jest.fn(async (...args: unknown[]) => {
      grants.push(args);
      return { contactId: 'c-1', activatedBindings: 0, created: true };
    }),
  };
  const audit = { append: jest.fn(async (i: Record<string, unknown>) => audits.push(i)) };
  return {
    service: new OwnerHousesService(prisma as never, bindingSync as never, audit as never),
    bindingCreates,
    grants,
    audits,
  };
}

const DTO = { houseId: 'h1', relation: 'OWNER' as const, applicantName: '张三' };

test('selfApply 关:接口直接拒绝,提示联系物业——绕过 UI 也拦得住', async () => {
  const { service, bindingCreates } = makeService({ selfApply: false, selfApplyNeedsApproval: true });
  await expect(service.applyBinding('wx-1', DTO)).rejects.toThrow(BizException);
  await expect(service.applyBinding('wx-1', DTO)).rejects.toThrow(/联系物业/);
  expect(bindingCreates).toHaveLength(0);
});

test('需审批(默认):建 PENDING,不碰授权名单', async () => {
  const { service, bindingCreates, grants } = makeService({ selfApply: true, selfApplyNeedsApproval: true });
  await service.applyBinding('wx-1', DTO);
  expect(bindingCreates[0]).toMatchObject({ status: 'PENDING', source: 'APPLY' });
  expect(grants).toHaveLength(0);
});

test('免审批:申请即 ACTIVE + 手机号进授权名单 + 留痕', async () => {
  const { service, bindingCreates, grants, audits } = makeService({ selfApply: true, selfApplyNeedsApproval: false });
  await service.applyBinding('wx-1', DTO);
  expect(bindingCreates[0]).toMatchObject({ status: 'ACTIVE', source: 'APPLY' });
  // 与人工审批同一条 grantContact 路径(source=APPLY_APPROVED),从此删号即解绑
  expect(grants).toHaveLength(1);
  expect(JSON.stringify(grants[0])).toContain('APPLY_APPROVED');
  expect(audits.some((a) => JSON.stringify(a.afterSummary).includes('BINDING_AUTO_APPROVE'))).toBe(true);
});

test('免审批但用户没有手机号:绑定照常生效,只是不进名单', async () => {
  // 老版本注册且从未授权手机号的极少数用户:换租时物业要在绑定列表手动解除
  const { service, bindingCreates, grants } = makeService({ selfApply: true, selfApplyNeedsApproval: false }, null);
  await service.applyBinding('wx-1', DTO);
  expect(bindingCreates[0]).toMatchObject({ status: 'ACTIVE' });
  expect(grants).toHaveLength(0);
});

test('重复申请的拒绝要分「已绑定」和「审核中」两句话', async () => {
  /*
   * 2026-08-03 实测:业主申请了自己名下已绑定的房,得到「已绑定或已申请该房屋」,
   * 发截图来问「这是啥情况」。已绑定 → 该去看账单;审核中 → 该等物业。
   * 下一步完全不同的两种状态,不能合成一句让人猜。
   */
  const make = (status: string) => {
    const prisma = {
      raw: {
        house: { findUnique: jest.fn(async () => HOUSE) },
        houseBinding: { findUnique: jest.fn(async () => ({ id: 'b1', status })) },
      },
    };
    const bindingSync = { getConfig: jest.fn(async () => ({ phoneMatch: true, selfApply: true, selfApplyNeedsApproval: true })) };
    return new OwnerHousesService(prisma as never, bindingSync as never, {} as never);
  };
  await expect(make('ACTIVE').applyBinding('wx-1', DTO)).rejects.toThrow(/已经绑定在您名下.*无需再次申请/);
  await expect(make('PENDING').applyBinding('wx-1', DTO)).rejects.toThrow(/审核中，请耐心等待/);
});
