import { PaymentService } from './payment.service';

/**
 * 优惠券抵扣直接影响实收金额，必须逐条守住：
 * 归属、状态、有效期、适用小区、满减门槛、抵扣上限，以及并发下不可重复使用。
 */
describe('PaymentService 优惠券抵扣', () => {
  const DAY = 86_400_000;

  function coupon(over: Record<string, unknown> = {}) {
    return {
      enabled: true,
      communityId: null,
      faceValue: { toString: () => '10.00' },
      threshold: { toString: () => '100.00' },
      validFrom: new Date(Date.now() - DAY),
      validTo: new Date(Date.now() + DAY),
      name: '物业费满100减10',
      ...over,
    };
  }

  /** 直接测私有方法：它是抵扣的全部校验所在，值得单独覆盖 */
  function consume(
    service: PaymentService,
    tx: unknown,
    billCents: number,
    communityId = 'c1',
  ): Promise<number> {
    return (service as unknown as {
      consumeCouponInTx(tx: unknown, i: Record<string, unknown>): Promise<number>;
    }).consumeCouponInTx(tx, {
      tenantId: 't1',
      ownerId: 'o1',
      userCouponId: 'uc1',
      billCents,
      communityId,
    });
  }

  function makeTx(uc: unknown, usedCount = 1) {
    return {
      userCoupon: {
        findFirst: jest.fn().mockResolvedValue(uc),
        updateMany: jest.fn().mockResolvedValue({ count: usedCount }),
      },
    };
  }

  const service = new PaymentService(
    { raw: {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('正常抵扣：满门槛时扣券面额并把券置 USED', async () => {
    const tx = makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon() });
    const discount = await consume(service, tx, 22250);
    expect(discount).toBe(1000);
    expect(tx.userCoupon.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'uc1', status: 'UNUSED' } }),
    );
  });

  it('抵扣不超过账单金额（不产生负数应付、不退差额）', async () => {
    const tx = makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon({ threshold: null, faceValue: { toString: () => '50.00' } }) });
    await expect(consume(service, tx, 300)).resolves.toBe(300);
  });

  it('不满门槛拒绝', async () => {
    const tx = makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon() });
    await expect(consume(service, tx, 5000)).rejects.toThrow(/需满/);
  });

  it('已使用的券拒绝', async () => {
    const tx = makeTx({ id: 'uc1', status: 'USED', coupon: coupon() });
    await expect(consume(service, tx, 22250)).rejects.toThrow(/已使用|已过期/);
  });

  it('不属于本人或不存在时拒绝', async () => {
    const tx = makeTx(null);
    await expect(consume(service, tx, 22250)).rejects.toThrow(/不存在|不属于/);
  });

  it('过期 / 未生效 / 已停用 分别拒绝', async () => {
    await expect(
      consume(service, makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon({ validTo: new Date(Date.now() - DAY) }) }), 22250),
    ).rejects.toThrow(/已过期/);
    await expect(
      consume(service, makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon({ validFrom: new Date(Date.now() + DAY) }) }), 22250),
    ).rejects.toThrow(/尚未开始/);
    await expect(
      consume(service, makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon({ enabled: false }) }), 22250),
    ).rejects.toThrow(/已停用/);
  });

  it('限定小区的券用于别的小区时拒绝', async () => {
    const tx = makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon({ communityId: 'other' }) });
    await expect(consume(service, tx, 22250)).rejects.toThrow(/不适用于本小区/);
  });

  it('并发下已被抢用（updateMany count=0）时拒绝，避免一券两抵', async () => {
    const tx = makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon() }, 0);
    await expect(consume(service, tx, 22250)).rejects.toThrow(/刚刚已被使用/);
  });

  it('无面额的券拒绝', async () => {
    const tx = makeTx({ id: 'uc1', status: 'UNUSED', coupon: coupon({ faceValue: null }) });
    await expect(consume(service, tx, 22250)).rejects.toThrow(/无可抵扣金额/);
  });

  describe('订单未成交时退还券', () => {
    function release(service: PaymentService, paymentId: string) {
      return (service as unknown as { releaseCouponFor(id: string): Promise<void> }).releaseCouponFor(paymentId);
    }

    it('订单带券时把券置回 UNUSED（条件更新，重复调用幂等）', async () => {
      const userCoupon = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue({ userCouponId: 'uc9' }) },
          userCoupon,
        },
      };
      const svc = new PaymentService(prisma as never, {} as never, {} as never, {} as never, {} as never);
      await release(svc, 'pay-1');
      expect(userCoupon.updateMany).toHaveBeenCalledWith({
        where: { id: 'uc9', status: 'USED' },
        data: { status: 'UNUSED', usedAt: null },
      });
    });

    it('订单未用券时不做任何写入', async () => {
      const userCoupon = { updateMany: jest.fn() };
      const prisma = {
        raw: {
          payment: { findUnique: jest.fn().mockResolvedValue({ userCouponId: null }) },
          userCoupon,
        },
      };
      const svc = new PaymentService(prisma as never, {} as never, {} as never, {} as never, {} as never);
      await release(svc, 'pay-1');
      expect(userCoupon.updateMany).not.toHaveBeenCalled();
    });
  });
});
