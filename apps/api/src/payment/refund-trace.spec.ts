import { ErrorCode } from '@pf/shared';
import { RefundService } from './refund.service';

/**
 * 退款侧的可观测性与补救入口。
 *
 * 2026-08-01：一笔 ¥1 的退款微信 3 秒就退完了、业主微信里已到账，
 * 而后台显示「退款中」整整 10 分钟 —— 退款回调一次都没到，
 * 全靠当时 10 分钟一轮的查单兜底才对齐。
 *
 * 那 10 分钟里后台只能看到一个 PROCESSING：
 *   · 看不出微信到底退没退
 *   · 看不出回调有没有来过（这是判断链路健康的唯一线索）
 *   · 也没有任何按钮能立刻去问一次
 * 支付侧早就补过这两样（/admin/payments/trace + force-sync），退款侧漏了。
 */

function makeService(over: Record<string, unknown> = {}) {
  const refund = {
    id: 'refund-1',
    tenantId: 't1',
    communityId: 'c1',
    paymentId: 'pay-1',
    paymentOrderNo: 'WY20260801844562',
    refundNo: 'RF-WY20260801844562',
    refundAmount: '1',
    status: 'PROCESSING',
    notifyReceivedAt: null,
    lastQueriedAt: new Date('2026-08-01T15:20:30Z'),
    refundedAt: null,
    failureCode: null,
    failureMessage: null,
    attempts: [{ attemptNo: 1, status: 'PENDING' }],
    ...over,
  };
  const findFirst = jest.fn(async () => refund);
  const eventFindMany = jest.fn(async () => [
    {
      type: 'REFUNDED',
      status: 'PROCESSED',
      source: 'WXPAY_NOTIFY',
      occurredAt: new Date('2026-08-01T15:20:33Z'),
      processedAt: null,
      attempts: 0,
      lastError: null,
      summary: null,
    },
  ]);
  const prisma = {
    raw: {
      refund: { findFirst, updateMany: jest.fn() },
      paymentEvent: { findMany: eventFindMany },
    },
  };
  const service = new RefundService(
    prisma as never,
    { queryRefund: jest.fn() } as never,
    { reserve: jest.fn(), complete: jest.fn(), fail: jest.fn() } as never,
    { append: jest.fn() } as never,
  );
  return { service, findFirst, eventFindMany, refund };
}

describe('退款溯源', () => {
  it('给出一句话结论，而不是一堆时间戳', async () => {
    const { service } = makeService();
    const t = (await service.trace('WY20260801844562', 't1')) as unknown as {
      settlement: { done: boolean; via: string | null; wxCallbackArrived: boolean };
    };
    expect(t.settlement).toEqual(
      expect.objectContaining({ done: false, via: null, wxCallbackArrived: false }),
    );
  });

  it('已成功且回调到过 → 判为「微信回调确认」', async () => {
    const { service } = makeService({
      status: 'SUCCESS',
      notifyReceivedAt: new Date('2026-08-01T15:20:33Z'),
      refundedAt: new Date('2026-08-01T15:20:33Z'),
    });
    const t = (await service.trace('WY1', 't1')) as unknown as { settlement: { via: string } };
    expect(t.settlement.via).toBe('WXPAY_NOTIFY');
  });

  it('已成功但回调从未到过 → 判为「查单补回」，这是要上报的运维事实', async () => {
    /*
     * 这一条是整个溯源最重要的信息。「一直靠查单补回」说明回调链路没通 ——
     * 钱虽然对上了，但每一笔都要多等一轮扫描，而且回调是主路径、查单只是兜底。
     * 2026-08-01 的三笔退款全是这个形态。
     */
    const { service } = makeService({
      status: 'SUCCESS',
      notifyReceivedAt: null,
      refundedAt: new Date('2026-08-01T15:20:33Z'),
    });
    const t = (await service.trace('WY1', 't1')) as unknown as {
      settlement: { via: string; wxCallbackArrived: boolean };
    };
    expect(t.settlement.via).toBe('WXPAY_QUERY');
    expect(t.settlement.wxCallbackArrived).toBe(false);
  });

  it('带出退款事件时间线（此前零个端点暴露）', async () => {
    const { service, eventFindMany } = makeService();
    const t = (await service.trace('WY1', 't1')) as unknown as { events: unknown[] };
    expect(eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { refundId: 'refund-1' } }),
    );
    expect(t.events).toHaveLength(1);
  });

  it('保留失败原因——卡住时这是唯一能照着办的线索', async () => {
    // 真实例子：NOT_ENOUGH 基本账户余额不足，请充值后重新发起
    const { service } = makeService({
      status: 'FAILED',
      failureCode: 'NOT_ENOUGH',
      failureMessage: '微信支付接口失败：NOT_ENOUGH: 基本账户余额不足，请充值后重新发起',
    });
    const t = (await service.trace('WY1', 't1')) as unknown as { failureMessage: string };
    expect(t.failureMessage).toContain('余额不足');
  });

  it('租户管理员只能查本租户（跨租户读取要被挡住）', async () => {
    const { service, findFirst } = makeService();
    await service.trace('WY1', 't1');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1' }) }),
    );
  });

  it('查不到 → NOT_FOUND，而不是返回一个空壳', async () => {
    const { service, findFirst } = makeService();
    findFirst.mockResolvedValue(null as never);
    await expect(service.trace('WY-nope', 't1')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND.code,
    });
  });
});

describe('立即向微信查单', () => {
  it('按订单号解析出退款单号后查单', async () => {
    const { service } = makeService();
    const spy = jest.spyOn(service, 'recoverRefund').mockResolvedValue({
      refundNo: 'RF-WY20260801844562',
      status: 'SUCCESS',
    });
    await expect(service.forceQuery('WY20260801844562', 't1')).resolves.toMatchObject({
      status: 'SUCCESS',
    });
    expect(spy).toHaveBeenCalledWith('RF-WY20260801844562');
  });

  it('别家租户的订单 → 按「找不到」拒绝，不确认它存在', async () => {
    /*
     * 查单走 prisma.raw（回调与 cron 都没有租户上下文），所以防护必须显式。
     * 用 NOT_FOUND 而不是 FORBIDDEN：后者等于告诉调用方「这个订单号是真的」。
     */
    const { service } = makeService({ tenantId: 't-other' });
    const spy = jest.spyOn(service, 'recoverRefund');
    await expect(service.forceQuery('WY20260801844562', 't1')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND.code,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('查单返回 null（非可查状态）时不吞掉，原样回当前状态', async () => {
    const { service } = makeService({ status: 'FAILED' });
    jest.spyOn(service, 'recoverRefund').mockResolvedValue(null);
    await expect(service.forceQuery('WY1', 't1')).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('管理端两个接口都把自己的租户传下来', () => {
    /*
     * 防护只在调用方真的传了租户时才生效；忘记传不会报错、也没有任何症状，
     * 只是防护静默消失。
     */
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'admin-refund.controller.ts'),
      'utf8',
    ) as string;
    for (const name of ['trace', 'forceQuery']) {
      const i = src.indexOf(`  ${name}(@Current()`);
      expect(i).toBeGreaterThan(0);
      expect(src.slice(i, src.indexOf('\n  }', i))).toContain('cur.tenantId');
    }
  });
});
