import { AlertService, ALERT_DISPATCHER } from './alert.service';

describe('AlertService 运营告警', () => {
  let incidents: { openOrReopen: jest.Mock };
  let dispatcher: { deliver: jest.Mock; configured: jest.Mock };
  let store: Map<string, any>;
  let attempts: any[];

  beforeEach(() => {
    incidents = { openOrReopen: jest.fn().mockResolvedValue({ id: 'inc-1' }) };
    dispatcher = { deliver: jest.fn().mockResolvedValue({ ok: true, statusCode: 200 }), configured: jest.fn().mockReturnValue(true) };
    store = new Map();
    attempts = [];
  });

  function makePrisma() {
    return {
      raw: {
        operationalAlert: {
          findUnique: jest.fn(async ({ where }: any) => store.get(where.tenantId_dedupKey.dedupKey) || null),
          create: jest.fn(async ({ data }: any) => {
            const row = { id: `alert-${store.size + 1}`, occurrences: 1, ...data };
            store.set(data.dedupKey, row);
            return row;
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const row = [...store.values()].find((r) => r.id === where.tenantId_id.id);
            for (const [k, v] of Object.entries<any>(data)) {
              if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] || 0) + v.increment;
              else row[k] = v;
            }
            return row;
          }),
        },
        alertAttempt: {
          create: jest.fn(async ({ data }: any) => {
            attempts.push(data);
            return data;
          }),
        },
      },
    };
  }

  const make = (prisma: any) =>
    new AlertService(prisma as never, incidents as never, dispatcher as never);

  const base = {
    tenantId: 'tenant-1',
    communityId: 'community-1',
    alertType: 'PAYMENT_CALLBACK_REJECTED',
    severity: 'CRITICAL' as const,
    dedupKey: 'pay-cb-reject:WY1',
    title: '支付回调验签失败',
  };

  it('首次触发创建告警、投递并持久化投递尝试', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    const res = await svc.emit({ ...base, summary: '验签失败' });
    expect(res.deduped).toBe(false);
    expect(res.delivered).toBe(true);
    expect(dispatcher.deliver).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].success).toBe(true);
    // CRITICAL 告警映射为事件
    expect(incidents.openOrReopen).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: base.dedupKey }));
  });

  it('相同 dedupKey 去重：累加次数而非新建，尝试号递增', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    await svc.emit(base);
    const res2 = await svc.emit(base);
    expect(res2.deduped).toBe(true);
    expect(prisma.raw.operationalAlert.create).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].attemptNo).toBe(2);
  });

  it('投递失败保留 FAILED，重试后可成功', async () => {
    const prisma = makePrisma();
    dispatcher.deliver.mockResolvedValueOnce({ ok: false, statusCode: 500, error: 'boom' });
    const svc = make(prisma);
    const res = await svc.emit(base);
    expect(res.delivered).toBe(false);
    expect(attempts[0].success).toBe(false);
    // 重试
    const again = await svc.emit(base);
    expect(again.delivered).toBe(true);
    expect(attempts[1].success).toBe(true);
  });

  it('投递前脱敏：不写入手机号/密钥等敏感信息', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    await svc.emit({
      ...base,
      summary: '手机号 13800001111 验签失败',
      context: { apiV3Key: 'super-secret-key', phone: '13800001111', note: 'ok' },
    });
    const created = prisma.raw.operationalAlert.create.mock.calls[0][0].data;
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain('13800001111');
    expect(serialized).not.toContain('super-secret-key');
    expect(serialized).toContain('ok');
    // 投递载荷同样脱敏
    const payload = JSON.stringify(dispatcher.deliver.mock.calls[0][0]);
    expect(payload).not.toContain('13800001111');
    expect(payload).not.toContain('super-secret-key');
  });

  it('WARNING 告警不创建事件', async () => {
    const prisma = makePrisma();
    const svc = make(prisma);
    await svc.emit({ ...base, severity: 'WARNING', dedupKey: 'stale:WY9' });
    expect(incidents.openOrReopen).not.toHaveBeenCalled();
  });

  it('灰度就绪检查：未配置告警目的地视为不健康', async () => {
    const prisma = makePrisma();
    dispatcher.configured.mockReturnValue(false);
    const svc = make(prisma);
    const readiness = svc.readiness();
    expect(readiness.healthy).toBe(false);
    expect(readiness.destinationConfigured).toBe(false);
  });

  it('ALERT_DISPATCHER 令牌导出可用于注入', () => {
    expect(typeof ALERT_DISPATCHER).toBe('symbol');
  });
});
