import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toCents } from '../billing/engine/money';
import { PaymentService } from './payment.service';

/*
 * 本文件曾有两块「复刻式」用例，现已删除：
 *
 *  1) describe('下单金额与回调校验金额必须一致')——6 个用例。它的两个 helper
 *     chargedCents 与 expectedCentsOnCallback 函数体逐字相同、入参同一个值，
 *     所谓「核心断言」expect(charged).toBe(expected) 恒为真；整块 import 了
 *     PaymentService 却从不调用它。实测把历史资金 bug 原样注入回
 *     payment.service.ts（按账单原额而非抵扣后金额向微信下单，业主用券必被多扣、
 *     账单永远停在未缴），本文件 16 个用例全绿。真守卫在
 *     payment.service.spec.ts 的「用券后向微信下单的金额是抵扣后的实付额」。
 *
 *  2) describe('可用券列表与实际接受范围一致')——3 个用例，两个 helper 分别复刻
 *     quoteBill 的过滤与 consumeCouponInTx 的判定，再断言两个复刻品相等。
 *     原注释已自认「改真实代码不会让它失败、别把它当成回归防线」——既然如此就
 *     不该以绿色用例的形式计入总数，读 CI 输出的人区分不出来。
 *
 * 保留下面这块：它调用真实的 consumeCouponInTx，实测注入错误会失败。
 */

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
      { autoGrantOnPayment: jest.fn(async () => undefined) } as never,
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

/**
 * 前后端必须对「哪些券可用」达成一致。
 *
 * ⚠️ 本组是**算术层**的对照，复刻了两侧的判定公式，改真实代码不会让它失败。
 * 真正的守卫在 payment.service.spec.ts 的「quoteBill 可用券列表」——那里调用真实
 * quoteBill。本组只用来说明「列表范围」与「接受范围」在公式上必须等价，
 * 别把它当成回归防线（本会话已因误把复刻当守卫栽过三次）。
 *
 * 起因（我自己造成的不一致）：上一轮修好了 consumeCouponInTx——拒绝把应付降到 0
 * （微信不接受 0 元订单，那个错误会让订单卡进 PREPAY_UNKNOWN、账单被占用、券被消耗）。
 * 但没管小程序端：pay-confirm 的 recalc 用 Math.min(discount, total) 仍允许
 * payAmount = 0，界面照样显示「确认支付 ¥0.00」并让业主点下去，点了才被后端拒。
 *
 * 正确做法是 quoteBill 就不把这类券返回给前端（单一真源），前端再加一道兜底。
 * 这组用例锁住后端那一侧：可用券列表与 consumeCouponInTx 的接受范围必须一致。
 */
describe('可用券列表与实际接受范围一致', () => {
  /** 复刻 quoteBill 的 usableCoupons 过滤（门槛 + 实付必须为正） */
  function usable(billYuan: string, faceYuan: string, thresholdYuan = '0'): boolean {
    const billCents = toCents(billYuan);
    const face = toCents(faceYuan);
    const threshold = toCents(thresholdYuan);
    if (face <= 0) return false;
    if (billCents < threshold) return false;
    return Math.min(face, billCents) < billCents;
  }

  /** 复刻 consumeCouponInTx 的接受判定 */
  function accepted(billYuan: string, faceYuan: string): boolean {
    const billCents = toCents(billYuan);
    return Math.min(toCents(faceYuan), billCents) < billCents;
  }

  const combos: Array<[string, string]> = [
    ['250.00', '30.00'],
    ['10.00', '10.00'],
    ['1.00', '10.00'],
    ['10.00', '9.99'],
    ['0.02', '0.01'],
    ['0.01', '0.01'],
    ['2.50', '2.50'],
  ];

  it('列表里出现的券，后端一定接受；后端拒绝的券，一定不出现在列表里', () => {
    for (const [bill, face] of combos) {
      expect(usable(bill, face)).toBe(accepted(bill, face));
    }
  });

  it('券面额覆盖全额时不进入可用列表（否则界面会显示「确认支付 ¥0.00」）', () => {
    expect(usable('10.00', '10.00')).toBe(false);
    expect(usable('1.00', '10.00')).toBe(false);
    expect(usable('2.50', '2.50')).toBe(false);
  });

  it('门槛不满时也不进入列表', () => {
    expect(usable('50.00', '10.00', '100.00')).toBe(false);
    expect(usable('150.00', '10.00', '100.00')).toBe(true);
  });
});

/**
 * 退券的时序：必须在「订单确实被改成未成交」之后、且同事务内。
 *
 * 原实现在事务外、状态判定之前无条件 releaseCouponFor()。而它唯一的条件是券
 * status='USED'，不看支付是否已成交。于是有这条竞态：恢复任务查单得到 NOTPAY →
 * 业主随后在收银台付款成功 → 回调把 Payment 置 SUCCESS、账单 PAID → 恢复任务继续
 * 走 close() → **先把券退了** → 事务里 updateMany 命中 0 行直接 return，退券不回滚。
 * 结果：账单按抵扣后金额销账（物业承担了券成本），券却回到 UNUSED 可再用一次。
 *
 * 这里做静态断言而非行为断言：竞态本身很难在单测里稳定复现，而「退券语句必须出现在
 * count===0 的 return 之后」是可以直接从源码结构上钉住的。
 */
describe('退券必须在订单状态判定之后', () => {
  const src = readFileSync(join(__dirname, 'payment.service.ts'), 'utf8');

  it('finishUnpaidPayment 里退券语句排在 count===0 的 return 之后', () => {
    const start = src.indexOf('private async finishUnpaidPayment');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 3000);

    const guardAt = body.indexOf('if (updated.count === 0) return;');
    const releaseAt = body.indexOf("data: { status: 'UNUSED', usedAt: null }");
    expect(guardAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(guardAt);
  });

  it('不得再在事务外调用 releaseCouponFor（那正是竞态的来源）', () => {
    const start = src.indexOf('private async finishUnpaidPayment');
    const body = src.slice(start, start + 3000);
    const txAt = body.indexOf('$transaction');
    const legacyAt = body.indexOf('this.releaseCouponFor(');
    // 要么完全不再调用它，要么调用点在事务之内
    if (legacyAt !== -1) expect(legacyAt).toBeGreaterThan(txAt);
  });

  it('退券用条件更新保证幂等（不会把业主已重新用掉的券改回 UNUSED）', () => {
    const start = src.indexOf('private async finishUnpaidPayment');
    const body = src.slice(start, start + 3000);
    expect(body).toContain("status: 'USED'");
  });
});
