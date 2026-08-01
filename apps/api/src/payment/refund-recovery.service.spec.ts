import { RefundRecoveryService } from './refund-recovery.service';

describe('RefundRecoveryService', () => {
  const originalMode = process.env.PAY_MODE;
  afterEach(() => { process.env.PAY_MODE = originalMode; });

  it('扫描未终结（含失败态）退款并以租约认领后逐笔查单，单笔失败不阻断', async () => {
    process.env.PAY_MODE = 'wxpay';
    const prisma = {
      raw: {
        refund: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'r1', refundNo: 'RF-1', lastQueriedAt: null },
            { id: 'r2', refundNo: 'RF-2', lastQueriedAt: new Date('2026-07-22T09:00:00Z') },
          ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      },
    };
    const refunds = {
      recoverRefund: jest.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({ status: 'SUCCESS' }),
    };
    const service = new RefundRecoveryService(prisma as never, refunds as never);

    await service.recoverStaleRefunds(new Date('2026-07-22T10:00:00Z'));

    expect(prisma.raw.refund.findMany).toHaveBeenCalledWith(expect.objectContaining({
      // 含 FAILED/ABNORMAL：本地失败但微信侧可能已成功退款（商户平台人工重发或
      // 受理后异步转成功）。若不扫这两个状态，会出现「钱已退给业主而账单仍显示
      // 已缴、还能继续开票」的资金窟窿。
      where: expect.objectContaining({
        channel: 'WXPAY',
        status: { in: ['CREATED', 'PROCESSING', 'FAILED', 'ABNORMAL'] },
      }),
    }));
    expect(prisma.raw.refund.updateMany).toHaveBeenCalledTimes(2);
    expect(refunds.recoverRefund).toHaveBeenCalledTimes(2);
  });

  it('认领失败（被其他实例抢占）时跳过', async () => {
    process.env.PAY_MODE = 'wxpay';
    const prisma = {
      raw: {
        refund: {
          findMany: jest.fn().mockResolvedValue([{ id: 'r1', refundNo: 'RF-1', lastQueriedAt: null }]),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      },
    };
    const refunds = { recoverRefund: jest.fn() };
    const service = new RefundRecoveryService(prisma as never, refunds as never);

    await service.recoverStaleRefunds(new Date('2026-07-22T10:00:00Z'));
    expect(refunds.recoverRefund).not.toHaveBeenCalled();
  });
});

/**
 * 退款状态对齐必须够快。
 *
 * 2026-08-01 实测：退款 15:20:28 发起，微信 15:20:30~33 就退完了 ——
 * 业主微信里已经收到钱，而**退款回调一次都没到达**（notifyReceivedAt 始终为 null），
 * 我们直到 15:30:30 的下一轮 cron 查单才发现，后台整整 10 分钟显示「退款中」。
 *
 * 这和支付侧刚修过的形状完全一样（回调不可靠 → 查单兜底 → 兜底太慢），
 * 只是当时只改了支付、漏了退款。
 *
 * 退款查单是只读且幂等的，而且退款没有「关单」这类破坏性动作，
 * 所以不需要像支付那样区分「早查单、晚关单」—— 单纯查得勤一点就对了。
 */
describe('退款对齐的时效', () => {
  const originalMode = process.env.PAY_MODE;
  beforeEach(() => {
    process.env.PAY_MODE = 'wxpay';
  });
  afterEach(() => {
    process.env.PAY_MODE = originalMode;
  });

  it('扫描周期不超过 2 分钟', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'refund-recovery.service.ts'),
      'utf8',
    ) as string;
    const m = /@Cron\('0 \*\/(\d+) \* \* \* \*'\)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(2);
  });

  it('租约必须短于扫描周期，否则「查得勤」被租约拖回去', async () => {
    /*
     * 2 分钟一轮 + 5 分钟租约 = 一笔退款查过一次无果后要再等 5 分钟。
     * 而退款完成的那一刻常常就在第一次查单的同一秒（实测 refundedAt 与
     * lastQueriedAt 都是 15:20:30），第一次必然问早了 —— 复查间隔就是业主
     * 看到「退款中」的时长。
     */
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { raw: { refund: { findMany, updateMany: jest.fn() } } };
    const service = new RefundRecoveryService(prisma as never, { recoverRefund: jest.fn() } as never);
    const now = new Date('2026-08-01T15:30:00Z');
    await service.recoverStaleRefunds(now);
    const where = findMany.mock.calls[0][0].where;
    const leaseCutoff = where.OR[1].lastQueriedAt.lt as Date;
    expect(now.getTime() - leaseCutoff.getTime()).toBeLessThanOrEqual(2 * 60 * 1000);
  });

  it('仍然把 FAILED / ABNORMAL 一起扫——本地失败但微信侧可能已成功', async () => {
    /*
     * 这条是防「优化」优化掉的：只扫 PROCESSING 看起来更省，
     * 但本地记 FAILED、微信实际已退款的差异就永远没人对齐了。
     */
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { raw: { refund: { findMany, updateMany: jest.fn() } } };
    const service = new RefundRecoveryService(prisma as never, { recoverRefund: jest.fn() } as never);
    await service.recoverStaleRefunds(new Date('2026-08-01T15:30:00Z'));
    expect(findMany.mock.calls[0][0].where.status.in).toEqual(
      expect.arrayContaining(['PROCESSING', 'FAILED', 'ABNORMAL']),
    );
  });
});
