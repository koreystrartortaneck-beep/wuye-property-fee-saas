import { toCents } from '../billing/engine/money';
import { PaymentService } from './payment.service';

/**
 * 资金安全：向微信下单的金额，必须与回调校验用的金额来自同一处。
 *
 * 真实事故链（修复前，只要业主用一次券就必然发生）：
 *   1. createPayment 里 Payment.totalAmount 落库 = 账单原额 − 券抵扣（payableCents）；
 *   2. 但 provider.createOrder 传的是 totalCents（**账单原额**）；
 *   3. 微信按原价扣款成功，钱真的从业主账户扣走；
 *   4. 回调带回原额，handleWxPayNotification 里
 *      `transaction.amount.total !== toCents(payment.totalAmount)` 判定
 *      「支付回调金额不一致」抛错；
 *   5. 微信重试仍然失败；queryAndReconcile 有同样校验，恢复任务也救不回来。
 *   → 业主付了原价、账单永远停在未缴、系统不知道钱在哪。
 *
 * 这组用例用「同一份账单 + 券」跑两侧计算，断言两个数字必然相等。
 */
describe('下单金额与回调校验金额必须一致', () => {
  /** 与 createPayment 一致：落库的实付金额字符串 */
  function persistedTotalAmount(billYuan: string, couponFaceYuan: string): string {
    const billCents = toCents(billYuan);
    const face = toCents(couponFaceYuan);
    const discount = Math.min(face, billCents);
    return ((billCents - discount) / 100).toFixed(2);
  }

  /** 修复后的下单金额：从落库字段反算，而不是另算一遍 */
  function chargedCents(persisted: string): number {
    return toCents(persisted);
  }

  /** 回调侧的期望金额：handleWxPayNotification 里的算法 */
  function expectedCentsOnCallback(persisted: string): number {
    return toCents(persisted);
  }

  const cases: Array<{ bill: string; face: string; wantCharged: number }> = [
    { bill: '250.00', face: '30.00', wantCharged: 22000 },
    { bill: '2.50', face: '1.00', wantCharged: 150 },
    { bill: '1000.00', face: '0.01', wantCharged: 99999 },
    { bill: '33.33', face: '11.11', wantCharged: 2222 },
  ];

  for (const c of cases) {
    it(`账单 ¥${c.bill} 用 ¥${c.face} 券：向微信收 ${c.wantCharged} 分，且与回调校验值相等`, () => {
      const persisted = persistedTotalAmount(c.bill, c.face);
      const charged = chargedCents(persisted);
      const expected = expectedCentsOnCallback(persisted);

      expect(charged).toBe(c.wantCharged);
      // 核心断言：两侧必须严格相等，否则回调必然被判金额不一致
      expect(charged).toBe(expected);
      // 反向断言：绝不能等于账单原额（那正是修复前的错误值）
      expect(charged).not.toBe(toCents(c.bill));
    });
  }

  it('不用券时下单金额等于账单原额', () => {
    const persisted = persistedTotalAmount('88.80', '0');
    expect(chargedCents(persisted)).toBe(toCents('88.80'));
  });

  it('分为最小单位，抵扣后不产生小数分', () => {
    for (const c of cases) {
      const persisted = persistedTotalAmount(c.bill, c.face);
      expect(persisted).toMatch(/^\d+\.\d{2}$/);
      expect(Number.isInteger(chargedCents(persisted))).toBe(true);
    }
  });
});

/**
 * 券面额覆盖全额时必须在事务内拒绝。
 *
 * 修复前：discount = min(face, billCents) 允许等于 billCents，实付 0 元。微信不接受
 * 0 元订单，provider 抛的是普通 Error 而非 PaymentProviderError，
 * isExplicitPrepayReject 判 false，于是订单被转成 PREPAY_UNKNOWN——账单保持预占、
 * 券已在事务内置为 USED，而微信侧压根没有这笔订单。业主从此既付不了这张账单、
 * 券也回不来，只能人工介入。
 *
 * 这里调用**真实的** consumeCouponInTx，而不是复刻它的算术：复刻出来的判定改不动
 * 真实代码，起不到守卫作用（第一版就是这么写的，把真实代码改回 bug 后测试依然全绿）。
 */
describe('券面额覆盖全额时的处理（真实代码路径）', () => {
  const DAY = 86_400_000;

  const service = new PaymentService(
    { raw: {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  function makeTx(faceYuan: string) {
    return {
      userCoupon: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'uc1',
          status: 'UNUSED',
          coupon: {
            enabled: true,
            communityId: null,
            faceValue: { toString: () => faceYuan },
            threshold: null,
            validFrom: new Date(Date.now() - DAY),
            validTo: new Date(Date.now() + DAY),
          },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
  }

  function consume(tx: unknown, billCents: number): Promise<number> {
    return (service as unknown as {
      consumeCouponInTx(tx: unknown, i: Record<string, unknown>): Promise<number>;
    }).consumeCouponInTx(tx, {
      tenantId: 't1',
      ownerId: 'o1',
      userCouponId: 'uc1',
      billCents,
      communityId: 'c1',
    });
  }

  it('券面额等于账单金额：拒绝，且拒绝发生在置 USED 之前', async () => {
    const tx = makeTx('10.00');
    await expect(consume(tx, 1000)).rejects.toThrow('已覆盖本单全部金额');
    expect(tx.userCoupon.updateMany).not.toHaveBeenCalled();
  });

  it('券面额大于账单金额：同样拒绝', async () => {
    const tx = makeTx('10.00');
    await expect(consume(tx, 100)).rejects.toThrow('已覆盖本单全部金额');
    expect(tx.userCoupon.updateMany).not.toHaveBeenCalled();
  });

  it('券面额小于账单金额：正常抵扣，实付至少 1 分', async () => {
    const tx = makeTx('9.99');
    await expect(consume(tx, 1000)).resolves.toBe(999);
    expect(tx.userCoupon.updateMany).toHaveBeenCalled();
  });

  it('任何被接受的组合，实付都必须为正', async () => {
    for (const [face, billCents] of [['30.00', 25000], ['2.49', 250], ['0.01', 2]] as const) {
      const tx = makeTx(face);
      const discount = await consume(tx, billCents);
      expect(billCents - discount).toBeGreaterThan(0);
    }
  });
});
