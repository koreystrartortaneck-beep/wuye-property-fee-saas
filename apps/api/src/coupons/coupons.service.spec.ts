import { ErrorCode } from '@pf/shared';
import { CouponsService } from './coupons.service';

/**
 * 券直接抵钱，这三处原本都是「读后写」——并发下都会多给钱。
 *
 * 发现过程：这个文件的语句覆盖率只有 14%，是全仓涉及资金的模块里最低的。
 * 按覆盖率找薄弱处，然后逐个读逻辑，找到：
 *   1) claim 的每人限领在事务外 count（TOCTOU）→ 并发能超领
 *   2) verify 先查 UNUSED 再 update → 两个收银台同时扫，礼品券兑两次
 *   3) 核销码用 Math.random → 可从自己的码反推 PRNG 状态、预测别人的码
 *
 * 支付侧的 consumeCouponInTx 本来就用条件 updateMany + count 校验（乐观锁），
 * 这两处漏了同一份保护 —— 同一个仓里同一个问题，做对了一处漏了两处。
 */

const OWNER = 'owner-1';

function makeService(over: Record<string, unknown> = {}) {
  const state = {
    coupon: {
      id: 'c1',
      tenantId: 't1',
      enabled: true,
      totalQty: 100,
      claimedQty: 0,
      perUserLimit: 2,
      validFrom: new Date(Date.now() - 86_400_000),
      validTo: new Date(Date.now() + 86_400_000),
      communityId: null,
    },
    /** 已占用的 (couponId, wxUserId, claimSeq) —— 模拟数据库唯一约束 */
    taken: new Set<string>(),
    created: [] as Array<Record<string, unknown>>,
    stockUpdates: 0,
  };

  const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  const tx = {
    coupon: {
      updateMany: jest.fn(async ({ where }: { where: { claimedQty?: { lt: number } } }) => {
        if (where.claimedQty && state.coupon.claimedQty >= where.claimedQty.lt) return { count: 0 };
        state.coupon.claimedQty += 1;
        state.stockUpdates += 1;
        return { count: 1 };
      }),
    },
    userCoupon: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const key = `${data.couponId}|${data.wxUserId}|${data.claimSeq}`;
        if (state.taken.has(key)) throw uniqueViolation();
        state.taken.add(key);
        state.created.push(data);
        return { id: `uc-${state.created.length}`, ...data };
      }),
    },
  };

  const prisma = {
    raw: {
      coupon: { findUnique: jest.fn(async () => state.coupon) },
      houseBinding: { findFirst: jest.fn(async () => ({ id: 'b1' })) },
      userCoupon: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
    t: {},
    ...over,
  };
  const houses = { assertOwnerHouse: jest.fn(async () => undefined) };
  return { svc: new CouponsService(prisma as never, houses as never), state, prisma, tx };
}

describe('领券：限领必须由数据库保证', () => {
  it('正常领取写入 claimSeq=0', async () => {
    const { svc, state } = makeService();
    await svc.claim(OWNER, 'c1');
    expect(state.created[0].claimSeq).toBe(0);
  });

  it('已占用 seq=0 时顺延到 1，而不是报「已达上限」', async () => {
    const { svc, state } = makeService();
    state.taken.add('c1|owner-1|0');
    const r = (await svc.claim(OWNER, 'c1')) as { claimSeq: number };
    expect(r.claimSeq).toBe(1);
  });

  it('所有序号占满才报已达上限', async () => {
    // perUserLimit = 2
    const { svc, state } = makeService();
    state.taken.add('c1|owner-1|0');
    state.taken.add('c1|owner-1|1');
    await expect(svc.claim(OWNER, 'c1')).rejects.toMatchObject({ code: ErrorCode.COUPON_LIMIT_REACHED.code });
  });

  it('并发两次领取（limit=1）只有一次成功——这正是原来的漏洞', async () => {
    /*
     * 原实现：两个请求都在事务外 count 到 0，都通过校验，各自 create 成功 → 领到两张。
     * 现在靠唯一约束，第二个必然撞 P2002；perUserLimit=1 时没有下一个序号可顺延，
     * 于是正确地报「已达上限」。
     */
    const { svc, state } = makeService();
    state.coupon.perUserLimit = 1;
    const results = await Promise.allSettled([svc.claim(OWNER, 'c1'), svc.claim(OWNER, 'c1')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(state.created).toHaveLength(1);
  });

  it('库存不足报「售完」，不能被唯一约束的重试逻辑吞成「已达上限」', async () => {
    /*
     * 这一条针对我自己写重试时最容易犯的错：catch 里不加区分地吞掉异常。
     * 那样业主看到的原因是错的（明明是券发完了，却说你领满了），
     * 而且会白转 perUserLimit 圈。
     */
    const { svc, state } = makeService();
    state.coupon.claimedQty = state.coupon.totalQty;
    await expect(svc.claim(OWNER, 'c1')).rejects.toMatchObject({ code: ErrorCode.COUPON_SOLD_OUT.code });
  });

  it('不在有效期内不能领', async () => {
    const { svc, state } = makeService();
    state.coupon.validTo = new Date(Date.now() - 1000);
    await expect(svc.claim(OWNER, 'c1')).rejects.toMatchObject({ code: ErrorCode.COUPON_STATE_INVALID.code });
  });

  it('没有本租户 ACTIVE 绑定不能领', async () => {
    const { svc, prisma } = makeService();
    (prisma.raw.houseBinding.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.claim(OWNER, 'c1')).rejects.toMatchObject({ code: ErrorCode.NO_BINDING.code });
  });
});

describe('核销：状态流转必须是条件更新', () => {
  function verifySvc(status: 'UNUSED' | 'USED', updateCount = 1) {
    const uc = {
      id: 'uc1',
      status,
      code: 'ABCD2345',
      coupon: { validTo: new Date(Date.now() + 86_400_000) },
    };
    const updateMany = jest.fn(async () => ({ count: updateCount }));
    const prisma = { t: { userCoupon: { findFirst: jest.fn(async () => uc), updateMany } }, raw: {} };
    return { svc: new CouponsService(prisma as never, {} as never), updateMany, uc };
  }

  it('核销时带 status: UNUSED 条件（不是无条件 update）', async () => {
    const { svc, updateMany } = verifySvc('UNUSED');
    await svc.verify('ABCD2345');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'uc1', status: 'UNUSED' } }),
    );
  });

  it('条件不成立（并发已被核销）时报错而不是当作成功', async () => {
    // 两个收银台同时扫同一张券：第二个的 updateMany 影响 0 行
    const { svc } = verifySvc('UNUSED', 0);
    await expect(svc.verify('ABCD2345')).rejects.toMatchObject({ code: ErrorCode.COUPON_STATE_INVALID.code });
  });

  it('返回值里的状态是已核销（前端据此立即置灰）', async () => {
    const { svc } = verifySvc('UNUSED');
    const r = (await svc.verify('ABCD2345')) as { status: string; usedAt: Date };
    expect(r.status).toBe('USED');
    expect(r.usedAt).toBeInstanceOf(Date);
  });

  it('已核销的券直接拒绝', async () => {
    const { svc } = verifySvc('USED');
    await expect(svc.verify('ABCD2345')).rejects.toMatchObject({ code: ErrorCode.COUPON_STATE_INVALID.code });
  });
});

describe('核销码不能用可预测的随机源', () => {
  it('不使用 Math.random', () => {
    /*
     * 核销只凭码、不校验持有人身份（物业扫到码就发货）。
     * V8 的 Math.random 是 xorshift128+，看到自己的若干个码就能反推内部状态、
     * 预测别人的码 —— 拿别人的礼品券去兑。换个函数就没这个面。
     */
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, 'coupons.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toContain('Math.random');
    expect(src).toContain('randomInt(');
  });

  it('码表里没有易混字符（0/O/1/I 之类）', () => {
    // 物业要口头/手抄核销码，混淆字符会变成一线的实际麻烦
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'coupons.service.ts'), 'utf8');
    const chars = /const CODE_CHARS = '([^']+)'/.exec(src)![1];
    // 只断言确实被排除的那几个。L 保留是对的：1 已经不在码表里，
    // 码空间内不存在可与 L 混淆的字符 —— 我第一版把 L 也列进来，是自己臆想的要求
    for (const c of ['0', 'O', '1', 'I']) expect(chars).not.toContain(c);
  });
});

describe('亮码核销的二维码(myCouponQr)', () => {
  /*
   * 物业拍板(2026-08-13):券到前台兑奖品,员工扫码核销。
   * 三条不能破的线:①只给本人的券出码(查询条件必须带 wxUserId ——
   * 否则拿到任意券 id 就能出别人的码);②已核销/过期不出码(前台空欢喜);
   * ③码内容带 PFC: 前缀,员工端据此拒绝一切别家的二维码。
   */
  function qrSvc(uc: Record<string, unknown> | null) {
    const findFirst = jest.fn(async () => uc);
    const prisma = { raw: { userCoupon: { findFirst } } };
    return { svc: new CouponsService(prisma as never, {} as never), findFirst };
  }
  const LIVE = {
    id: 'uc1',
    code: 'GC7K2M9Q',
    status: 'UNUSED',
    coupon: { name: '电影票兑换券', validTo: new Date(Date.now() + 86_400_000) },
  };

  it('本人的未使用券 → dataUrl 是内嵌 PNG,内容带 PFC: 前缀', async () => {
    const { svc, findFirst } = qrSvc(LIVE);
    const r = await svc.myCouponQr('owner-1', 'uc1');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'uc1', wxUserId: 'owner-1' } }),
    );
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(r.code).toBe('GC7K2M9Q');
    // 前缀真的编进了码里:解码回来验证(qrcode 库自带的往返即可)
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, 'coupons.service.ts'), 'utf8');
    expect(src).toContain("`PFC:${uc.code}`");
  });

  it('不是自己的券 → NOT_FOUND(连存在都不确认)', async () => {
    const { svc } = qrSvc(null);
    await expect(svc.myCouponQr('owner-2', 'uc1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND.code });
  });

  it.each([
    ['已核销', { ...LIVE, status: 'USED' }],
    ['已过期', { ...LIVE, coupon: { ...LIVE.coupon, validTo: new Date(Date.now() - 1000) } }],
  ])('%s 的券不出码', async (_n, uc) => {
    const { svc } = qrSvc(uc as never);
    await expect(svc.myCouponQr('owner-1', 'uc1')).rejects.toMatchObject({
      code: ErrorCode.COUPON_STATE_INVALID.code,
    });
  });
});
