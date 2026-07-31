import { OwnerAccountService } from './owner-account.service';

describe('OwnerAccountService 账号注销', () => {
  let audit: { append: jest.Mock };

  beforeEach(() => {
    audit = { append: jest.fn().mockResolvedValue(undefined) };
  });

  /**
   * 事务客户端。注销现在还要匿名化关联表里的个人信息——原实现只清了 WxUser 自身的
   * 四个字段，而姓名/手机号/车牌仍能用 wxUserId 从 HouseBinding / ServiceOrder /
   * VisitorPass / Payment.offlinePayerSnapshot 反查出来。
   *
   * 刻意**不**在这里提供 refund / bill / invoiceApplication / auditLog —— 事务客户端
   * 只暴露该动作允许触及的表，一旦实现里去动财务主体就会立刻 TypeError（见下方用例）。
   */
  function makeTx(offlinePayments: unknown[] = []) {
    return {
      houseBinding: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      wxUser: { update: jest.fn().mockResolvedValue({}) },
      serviceOrder: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      visitorPass: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      ticket: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      payment: {
        findMany: jest.fn().mockResolvedValue(offlinePayments),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }

  function makePrisma(user: unknown, bindings: unknown[], tx = makeTx()) {
    return {
      raw: {
        wxUser: { findUnique: jest.fn().mockResolvedValue(user) },
        houseBinding: { findMany: jest.fn().mockResolvedValue(bindings) },
        $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
      },
    };
  }

  it('匿名化身份、递增 tokenVersion 吊销令牌、解除活跃绑定并写审计', async () => {
    const tx = makeTx();
    const prisma = makePrisma(
      { id: 'wx-1', openid: 'openid-1', phone: '13800001111', deletedAt: null },
      [{ id: 'b1', tenantId: 't1' }],
      tx,
    );
    const service = new OwnerAccountService(prisma as never, audit as never);

    await expect(service.deleteAccount('wx-1')).resolves.toEqual({ deleted: true });

    // 匿名化 + 令牌吊销
    expect(tx.wxUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wx-1' },
        data: expect.objectContaining({
          openid: 'deleted:wx-1',
          phone: null,
          nickname: null,
          deletedAt: expect.any(Date),
          tokenVersion: { increment: 1 },
        }),
      }),
    );
    // 解除活跃/待审绑定
    expect(tx.houseBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ wxUserId: 'wx-1' }),
        data: expect.objectContaining({ status: 'REJECTED', revokeReason: '业主注销账号' }),
      }),
    );
    // 审计留痕
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'HouseBinding', action: 'CANCEL' }),
      tx,
    );
  });

  it('不删除任何财务/退款/发票/对账记录', async () => {
    const tx = makeTx();
    const prisma = makePrisma({ id: 'wx-1', openid: 'openid-1', phone: null, deletedAt: null }, [], tx);
    const service = new OwnerAccountService(prisma as never, audit as never);

    await service.deleteAccount('wx-1');

    /*
     * 事务客户端只暴露注销允许触及的表：一旦实现里去动 refund / bill /
     * invoiceApplication / auditLog，就会立刻 TypeError（这些 key 不存在）。
     * Payment 出现在清单里是因为要脱敏 offlinePayerSnapshot.payerName，
     * 但只允许 findMany/update，没有 delete/deleteMany 可用。
     */
    expect(Object.keys(tx).sort()).toEqual(
      ['houseBinding', 'payment', 'serviceOrder', 'ticket', 'visitorPass', 'wxUser'].sort(),
    );
    expect(Object.keys(tx.payment).sort()).toEqual(['findMany', 'update']);
  });

  it('关联表里的个人信息一并匿名化（否则仍能用 wxUserId 反查出这个人）', async () => {
    const tx = makeTx();
    const prisma = makePrisma({ id: 'wx-1', openid: 'openid-1', phone: '13800001111', deletedAt: null }, [], tx);
    await new OwnerAccountService(prisma as never, audit as never).deleteAccount('wx-1');

    // 绑定申请人姓名：要覆盖该用户**全部**绑定，不能只清 ACTIVE/PENDING 那批
    expect(tx.houseBinding.updateMany).toHaveBeenCalledWith({
      where: { wxUserId: 'wx-1' },
      data: { applicantName: null },
    });
    // 上门服务的联系人姓名与手机号
    expect(tx.serviceOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { wxUserId: 'wx-1' } }),
    );
    /*
     * 断言实际值而不是「不含手机号」——后者对任何字符串都恒真，属恒真断言。
     * contactName/contactPhone 是 NOT NULL 列，所以用固定占位而不是 null；
     * 占位文案要让物业在服务单列表里看得出「这个人已经注销了」。
     */
    const so = tx.serviceOrder.updateMany.mock.calls[0][0].data;
    expect(so.contactName).toBe('已注销业主');
    expect(so.contactPhone).toBe('');
    // 访客姓名/手机号/车牌
    const vp = tx.visitorPass.updateMany.mock.calls[0][0].data;
    expect(vp.visitorName).toBe('已注销业主');
    expect(vp.visitorPhone).toBeNull();
    expect(vp.plateNo).toBeNull();
  });

  it('报修文字保留、照片清空（文字要追溯处理过程，照片可能拍到户内/门牌/身份材料）', async () => {
    const tx = makeTx();
    const prisma = makePrisma({ id: 'wx-1', openid: 'o', phone: null, deletedAt: null }, [], tx);
    await new OwnerAccountService(prisma as never, audit as never).deleteAccount('wx-1');

    const data = tx.ticket.updateMany.mock.calls[0][0].data;
    expect(data.images).toEqual([]);
    // content 不在 data 里 = 没被清掉
    expect(data).not.toHaveProperty('content');
  });

  it('线下付款人姓名改存脱敏形式，而不是清空（财务凭证仍需可核对）', async () => {
    const tx = makeTx([
      { id: 'p1', offlinePayerSnapshot: { payerName: '张三', voucherNo: 'V-1' } },
      { id: 'p2', offlinePayerSnapshot: { payerName: '欧阳修', voucherNo: 'V-2' } },
      // 没有 payerName 的不该被改写
      { id: 'p3', offlinePayerSnapshot: { voucherNo: 'V-3' } },
    ]);
    const prisma = makePrisma({ id: 'wx-1', openid: 'o', phone: null, deletedAt: null }, [], tx);
    await new OwnerAccountService(prisma as never, audit as never).deleteAccount('wx-1');

    expect(tx.payment.update).toHaveBeenCalledTimes(2);
    const byId = new Map(
      tx.payment.update.mock.calls.map((c: [{ where: { id: string }; data: { offlinePayerSnapshot: Record<string, unknown> } }]) => [
        c[0].where.id,
        c[0].data.offlinePayerSnapshot,
      ]),
    );
    expect(byId.get('p1')).toEqual({ payerName: '张*', voucherNo: 'V-1' });
    expect(byId.get('p2')).toEqual({ payerName: '欧**', voucherNo: 'V-2' });
    // 凭证号等其它字段必须原样保留
    expect(byId.get('p1')).toHaveProperty('voucherNo', 'V-1');
  });

  it('账号不存在或已注销时拒绝', async () => {
    const service1 = new OwnerAccountService(makePrisma(null, []) as never, audit as never);
    await expect(service1.deleteAccount('missing')).rejects.toMatchObject({ code: 40400 });

    const service2 = new OwnerAccountService(
      makePrisma({ id: 'wx-1', deletedAt: new Date() }, []) as never,
      audit as never,
    );
    await expect(service2.deleteAccount('wx-1')).rejects.toMatchObject({ code: 40400 });
  });
});
