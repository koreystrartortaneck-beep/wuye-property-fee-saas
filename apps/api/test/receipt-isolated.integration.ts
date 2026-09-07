import { PrismaService } from '../src/prisma/prisma.service';
import { AdminPaymentsService } from '../src/payment/admin-payment.controller';
import { PaymentService } from '../src/payment/payment.service';
import { runWithTenant } from '../src/tenant/tenant-cls';

// 专用空库，无 dotenv、AppModule、定时任务或微信适配器；不清理已有数据。
// 只允许明确指定的本机临时库。测试结束由运行者销毁专用容器。
describe('收据查询：隔离 MySQL 集成', () => {
  let db: PrismaService;
  let listService: AdminPaymentsService;
  let receiptService: PaymentService;
  let tenantA: string;
  let tenantB: string;
  let secondHouse: string;
  let before: string;
  const snapshot = { receiptNo: 'TEST-R1', orderNo: 'TEST-WX', totalAmount: '302.00', house: '测试车库', bills: [] };
  const list = (q: Record<string, any> = {}, tenant?: string) => runWithTenant(tenant ?? tenantA,
    () => listService.list({ page: 1, pageSize: 20, channel: 'WXPAY', status: 'SUCCESS', ...q }));
  const financialState = async () => JSON.stringify({
    payments: await db.raw.payment.findMany({ orderBy: { id: 'asc' } }),
    bills: await db.raw.bill.findMany({ orderBy: { id: 'asc' } }),
    refunds: await db.raw.refund.count(),
    events: await db.raw.paymentEvent.count(),
  });

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || 'http://invalid');
    if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || url.pathname !== '/receipt_isolated') {
      throw new Error('必须使用 127.0.0.1 专用 receipt_isolated 空库');
    }
    db = new PrismaService();
    await db.$connect();
    if (await db.raw.tenant.count() || await db.raw.payment.count()) throw new Error('测试库非空，拒绝继续');
    listService = new AdminPaymentsService(db);
    receiptService = Object.create(PaymentService.prototype);
    Object.assign(receiptService, { prisma: db });
    const owner = await db.raw.wxUser.create({ data: { openid: 'receipt-isolated-owner' } });
    for (const code of ['receipt-test-a', 'receipt-test-b']) {
      const tenant = await db.raw.tenant.create({ data: { code, name: code } });
      if (code.endsWith('a')) tenantA = tenant.id; else tenantB = tenant.id;
      const admin = await db.raw.adminUser.create({ data: {
        tenantId: tenant.id, username: code, name: '测试员工', role: 'STAFF', passwordHash: 'not-a-login-hash',
      } });
      const community = await db.raw.community.create({ data: { tenantId: tenant.id, name: '收据测试小区' } });
      const bills: string[] = [];
      for (const houseCode of ['TEST-A-101', 'TEST-G-027']) {
        const house = await db.raw.house.create({ data: {
          tenantId: tenant.id, communityId: community.id, code: houseCode, displayName: houseCode,
          contacts: { create: { name: '测试联系人', phone: houseCode.includes('G-') ? '13800000002' : '13800000001' } },
        } });
        if (tenant.id === tenantA && houseCode.includes('G-')) secondHouse = house.id;
        const bill = await db.raw.bill.create({ data: {
          tenantId: tenant.id, communityId: community.id, houseId: house.id, title: '测试物业费',
          period: '2026', snapshot: {}, amount: 151, dueDate: new Date('2026-12-31'), status: 'PAID',
        } });
        bills.push(bill.id);
      }
      const cases = tenant.id === tenantA
        ? [['TEST-WX', 'WXPAY', 'SUCCESS'], ['TEST-OFF', 'OFFLINE', 'SUCCESS'], ['TEST-MOCK', 'MOCK', 'SUCCESS'], ['TEST-REFUND', 'WXPAY', 'REFUNDED'], ['TEST-PENDING', 'WXPAY', 'CREATED']]
        : [['TEST-OTHER', 'WXPAY', 'SUCCESS']];
      for (const [orderNo, channel, status] of cases) {
        await db.raw.payment.create({ data: {
          tenantId: tenant.id, communityId: community.id, wxUserId: owner.id, billId: bills[0],
          orderNo, channel: channel as any, status: status as any, totalAmount: 302,
          ...(channel === 'OFFLINE' ? { offlineVoucherNo: 'TEST-OFFLINE-VOUCHER', offlinePaidAt: new Date('2026-09-01'), offlineOperatorId: admin.id, offlinePayerSnapshot: { name: '测试付款人' } } : {}),
          ...(status !== 'CREATED' ? { receiptNo: `RC-${orderNo}`, receiptSnapshot: { ...snapshot, orderNo }, paidAt: new Date('2026-09-01') } : {}),
          paymentBills: { create: bills.map(billId => ({ billId })) },
        } });
      }
    }
    before = await financialState();
  });
  afterAll(async () => { if (db) await db.$disconnect(); });

  it('微信成功列表排除线下、模拟、退款、待支付及其他租户', async () => {
    const r = await list();
    expect(r.total).toBe(1);
    expect(r.list.map(p => p.orderNo)).toEqual(['TEST-WX']);
  });
  it.each(['13800000002', 'TEST-G-027', '测试联系人', 'RC-TEST-WX', 'TEST-WX'])('关键词 %s 找到合并订单且不重复计数', async keyword => {
    const r = await list({ keyword });
    expect(r.total).toBe(1);
    expect(r.list[0].orderNo).toBe('TEST-WX');
    expect(JSON.stringify(r)).not.toContain('13800000002');
  });
  it('房屋与手机号条件取交集，空白关键词不误过滤', async () => {
    expect((await list({ houseId: secondHouse, keyword: '13800000002' })).total).toBe(1);
    expect((await list({ houseId: secondHouse, keyword: '不存在' })).total).toBe(0);
    expect((await list({ keyword: '  ' })).total).toBe(1);
  });
  it('同名同号其他租户不可串入，缺失上下文返回空', async () => {
    expect((await list({ keyword: '13800000002' }, tenantB)).list.map(p => p.orderNo)).toEqual(['TEST-OTHER']);
    expect((await listService.list({ page: 1, pageSize: 20 })).total).toBe(0);
    await expect(receiptService.getAdminReceipt(tenantB, 'TEST-WX')).rejects.toThrow();
  });
  it('分页总数一致、跨页无重复，线下可独立查询', async () => {
    const first = await list({ status: undefined, pageSize: 2 });
    const second = await list({ status: undefined, pageSize: 2, page: 2 });
    expect(first.total).toBe(3); expect(second.total).toBe(3);
    expect(new Set([...first.list, ...second.list].map(p => p.id)).size).toBe(3);
    expect((await list({ channel: 'OFFLINE' })).list.map(p => p.orderNo)).toEqual(['TEST-OFF']);
  });
  it('业主和管理端读取同一快照，退款作废、待支付无收据', async () => {
    const payment = await db.raw.payment.findUniqueOrThrow({ where: { orderNo: 'TEST-WX' } });
    const admin = await receiptService.getAdminReceipt(tenantA, 'TEST-WX');
    const owner = await receiptService.getPayment(payment.wxUserId!, 'TEST-WX');
    expect(admin.receipt).toEqual(owner.receipt);
    expect(admin.receipt).toEqual(snapshot);
    expect(admin).not.toHaveProperty('wxUserId');
    expect((await receiptService.getAdminReceipt(tenantA, 'TEST-REFUND')).receiptVoid).toBe(true);
    expect((await receiptService.getAdminReceipt(tenantA, 'TEST-PENDING')).receipt).toBeNull();
    await expect(receiptService.getPayment('wrong-owner', 'TEST-WX')).rejects.toThrow();
  });
  it('读取后账单、支付、快照、退款和支付事件完全未变', async () => {
    expect(await financialState()).toBe(before);
  });
});
