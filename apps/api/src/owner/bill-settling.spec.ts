import { Prisma } from '@prisma/client';
import { OwnerBillsService } from './owner-bills.controller';

/**
 * 「已付款、还没入账」必须是一个业主看得见的状态。
 *
 * 2026-08-01 事故里最伤人的一屏：业主付完款回到账单页，看到的是「待缴」，
 * 而钱明明已经扣了。界面上没有一个字解释，他只能猜钱是不是丢了 ——
 * 最可能的下一步就是再付一次。
 *
 * 根子在设计：`wx.requestPayment` 成功是微信给的权威结论（钱已经扣了），
 * 而账单要变成「已缴」还得等我们收到回调或主动查单。这两件事之间有个几秒的窗口，
 * 系统原本没有任何词汇描述它 —— 只有「待缴」和「已缴」，于是只能显示成「待缴」。
 *
 * 判据取 `wxpayNotifiedAt != null`：微信的回调已到达并验签通过，
 * 也就是微信亲口确认过钱收了。这一条很要紧 —— 若改成「订单存在且未终结」，
 * 「业主点开收银台又放弃了」也会被标成已支付，那是反方向的谎，
 * 而且会连带把缴费按钮收起来，让他没法真的去付。
 */
describe('账单的「入账中」状态', () => {
  const findMany = jest.fn();
  const count = jest.fn().mockResolvedValue(1);
  const paymentFindMany = jest.fn();
  const houses = { assertOwnerHouse: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    raw: {
      bill: { findMany, count, findUnique: jest.fn() },
      payment: { findMany: paymentFindMany },
    },
  };
  const svc = new OwnerBillsService(prisma as never, houses as never);

  const bill = (over: Record<string, unknown> = {}) => ({
    id: 'bill-1',
    title: '住宅物业费 2026-07',
    period: '2026-07',
    amount: new Prisma.Decimal('2.50'),
    status: 'UNPAID',
    dueDate: new Date('2026-08-15'),
    paidAt: null,
    snapshot: null,
    ruleId: 'r1',
    paymentId: 'pay-1',
    ...over,
  });

  beforeEach(() => {
    findMany.mockReset();
    paymentFindMany.mockReset().mockResolvedValue([]);
  });

  async function listOne(over: Record<string, unknown> = {}) {
    findMany.mockResolvedValue([bill(over)]);
    const r = (await svc.list('owner-1', { houseId: 'h1' } as never)) as unknown as {
      list: Array<{ settling: boolean; paymentId?: string }>;
    };
    return r.list[0];
  }

  it('微信已确认扣款、账单还没销账 → settling', async () => {
    paymentFindMany.mockResolvedValue([{ id: 'pay-1' }]);
    expect((await listOne()).settling).toBe(true);
  });

  it('只查「微信已回调 + 订单仍未终结」的支付', async () => {
    await listOne();
    expect(paymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          wxpayNotifiedAt: { not: null },
          status: { in: ['CREATED', 'PREPAY_UNKNOWN'] },
        }),
      }),
    );
  });

  it('业主点开收银台又放弃了（没有回调）→ 不是 settling', async () => {
    /*
     * 这一条是反方向的保护。若把它标成「入账中」，缴费按钮会被收起来，
     * 业主就再也付不了这笔账单了 —— 比显示「待缴」严重得多。
     */
    paymentFindMany.mockResolvedValue([]);
    expect((await listOne()).settling).toBe(false);
  });

  it('还没下过单的账单 → 不查支付表，也不是 settling', async () => {
    const row = await listOne({ paymentId: null });
    expect(row.settling).toBe(false);
    expect(paymentFindMany).not.toHaveBeenCalled();
  });

  it('已缴的账单 → 不是 settling（不能和真正销账完的混在一起）', async () => {
    paymentFindMany.mockResolvedValue([{ id: 'pay-1' }]);
    const row = await listOne({ status: 'PAID', paidAt: new Date() });
    expect(row.settling).toBe(false);
  });

  it('paymentId 不外泄给业主端——它只用来派生 settling', async () => {
    paymentFindMany.mockResolvedValue([{ id: 'pay-1' }]);
    expect(await listOne()).not.toHaveProperty('paymentId');
  });

  it('详情页与列表口径一致（否则点进去又变回「待缴 + 立即缴纳」）', async () => {
    /*
     * 两处口径不一致最危险：列表说「入账中」不给按钮，详情说「待缴」给按钮，
     * 业主点进去就付了第二次。
     */
    prisma.raw.bill.findUnique = jest.fn().mockResolvedValue(bill({ houseId: 'h1' }));
    paymentFindMany.mockResolvedValue([{ id: 'pay-1' }]);
    const d = (await svc.detail('owner-1', 'bill-1')) as unknown as {
      settling: boolean;
      paymentId?: string;
    };
    expect(d.settling).toBe(true);
    expect(d).not.toHaveProperty('paymentId');
  });

  it('一页里混合时逐条判定，不是一竿子全标', async () => {
    findMany.mockResolvedValue([
      bill({ id: 'b1', paymentId: 'pay-1' }),
      bill({ id: 'b2', paymentId: 'pay-2' }),
      bill({ id: 'b3', paymentId: null }),
    ]);
    paymentFindMany.mockResolvedValue([{ id: 'pay-1' }]);
    const r = (await svc.list('owner-1', { houseId: 'h1' } as never)) as unknown as {
      list: Array<{ id: string; settling: boolean }>;
    };
    expect(r.list.map((b) => [b.id, b.settling])).toEqual([
      ['b1', true],
      ['b2', false],
      ['b3', false],
    ]);
  });
});
