import { HouseProfileService } from './house-profile.controller';

/**
 * 住户档案是接电话查户的唯一入口，汇总口径必须与欠费清单一致，
 * 且开票只能经 paymentId 反查（InvoiceApplication 没有 houseId 字段）。
 */
describe('HouseProfileService 住户档案', () => {
  const house = {
    id: 'h1',
    code: '1-101',
    displayName: '1栋1单元101',
    type: 'RESIDENCE',
    area: { toString: () => '89.00' },
    status: 'ACTIVE',
    ownerName: '张三',
    ownerPhone: '13800138000',
    community: { id: 'c1', name: '金港城', servicePhone: '400-1' },
  };

  function amt(v: string) {
    return { toString: () => v };
  }

  function makePrisma(over: Record<string, unknown> = {}) {
    return {
      t: {
        house: { findUnique: jest.fn().mockResolvedValue(house) },
        bill: { findMany: jest.fn().mockResolvedValue([]) },
        houseBinding: { findMany: jest.fn().mockResolvedValue([]) },
        ticket: { findMany: jest.fn().mockResolvedValue([]) },
        paymentBill: { findMany: jest.fn().mockResolvedValue([]) },
        payment: { findMany: jest.fn().mockResolvedValue([]) },
        invoiceApplication: { findMany: jest.fn().mockResolvedValue([]) },
        ...(over as object),
      },
    };
  }

  it('房屋不存在时报 404 而非返回空档案', async () => {
    const prisma = makePrisma({ house: { findUnique: jest.fn().mockResolvedValue(null) } });
    const service = new HouseProfileService(prisma as never);
    await expect(service.profile('nope')).rejects.toThrow();
  });

  it('汇总只统计 UNPAID 与 PAID，作废/退款不计入', async () => {
    const prisma = makePrisma({
      bill: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'b1', status: 'UNPAID', amount: amt('222.50'), period: '2026-08' },
          { id: 'b2', status: 'UNPAID', amount: amt('222.50'), period: '2026-07' },
          { id: 'b3', status: 'PAID', amount: amt('222.50'), period: '2026-06' },
          { id: 'b4', status: 'CANCELED', amount: amt('999.00'), period: '2026-05' },
          { id: 'b5', status: 'REFUNDED', amount: amt('888.00'), period: '2026-04' },
        ]),
      },
    });
    const service = new HouseProfileService(prisma as never);
    const res = await service.profile('h1');
    expect(res.summary.unpaidAmount).toBe('445.00');
    expect(res.summary.unpaidCount).toBe(2);
    expect(res.summary.paidAmount).toBe('222.50');
    expect(res.summary.paidCount).toBe(1);
  });

  it('待办计数：进行中工单与待审绑定', async () => {
    const prisma = makePrisma({
      ticket: {
        findMany: jest.fn().mockResolvedValue([
          { id: 't1', status: 'PENDING' },
          { id: 't2', status: 'PROCESSING' },
          { id: 't3', status: 'DONE' },
        ]),
      },
      houseBinding: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'g1', status: 'PENDING' },
          { id: 'g2', status: 'ACTIVE' },
        ]),
      },
    });
    const service = new HouseProfileService(prisma as never);
    const res = await service.profile('h1');
    expect(res.summary.openTickets).toBe(2);
    expect(res.summary.pendingBindings).toBe(1);
  });

  it('无支付时不查开票（避免拿空 in 查询全表）', async () => {
    const prisma = makePrisma();
    const service = new HouseProfileService(prisma as never);
    const res = await service.profile('h1');
    expect(prisma.t.invoiceApplication.findMany).not.toHaveBeenCalled();
    expect(res.invoices).toEqual([]);
  });

  it('开票按该房屋的支付订单反查（去重后的 paymentId）', async () => {
    const prisma = makePrisma({
      bill: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', status: 'PAID', amount: amt('1.00'), period: '2026-07' }]) },
      paymentBill: {
        findMany: jest.fn().mockResolvedValue([{ paymentId: 'p1' }, { paymentId: 'p1' }, { paymentId: 'p2' }]),
      },
      payment: { findMany: jest.fn().mockResolvedValue([{ id: 'p1', orderNo: 'WY1' }]) },
      invoiceApplication: { findMany: jest.fn().mockResolvedValue([{ id: 'i1', applicationNo: 'INV-1' }]) },
    });
    const service = new HouseProfileService(prisma as never);
    const res = await service.profile('h1');
    expect(prisma.t.invoiceApplication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: { in: ['p1', 'p2'] } } }),
    );
    expect(res.invoices).toHaveLength(1);
  });

  it('房屋基本信息含面积与管家电话（供接电话时直接答复）', async () => {
    const service = new HouseProfileService(makePrisma() as never);
    const res = await service.profile('h1');
    expect(res.house).toMatchObject({
      code: '1-101',
      area: '89.00',
      ownerPhone: '13800138000',
      communityName: '金港城',
      servicePhone: '400-1',
    });
  });
});
