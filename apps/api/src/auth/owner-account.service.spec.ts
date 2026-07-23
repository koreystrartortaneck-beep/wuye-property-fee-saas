import { OwnerAccountService } from './owner-account.service';

describe('OwnerAccountService 账号注销', () => {
  let audit: { append: jest.Mock };

  beforeEach(() => {
    audit = { append: jest.fn().mockResolvedValue(undefined) };
  });

  function makeTx() {
    return {
      houseBinding: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      wxUser: { update: jest.fn().mockResolvedValue({}) },
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

  it('不删除任何财务/退款/发票/对账记录（事务内仅触及绑定与身份表）', async () => {
    const tx = makeTx();
    const prisma = makePrisma({ id: 'wx-1', openid: 'openid-1', phone: null, deletedAt: null }, [], tx);
    const service = new OwnerAccountService(prisma as never, audit as never);

    await service.deleteAccount('wx-1');

    // tx 仅暴露 houseBinding 与 wxUser，无 payment/refund/invoice 等，天然不会误删财务数据
    expect(Object.keys(tx)).toEqual(['houseBinding', 'wxUser']);
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
