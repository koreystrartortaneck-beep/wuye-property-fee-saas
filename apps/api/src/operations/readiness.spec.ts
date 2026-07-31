import { AdminOperationsController } from './admin-operations.controller';

/**
 * 就绪检查必须暴露「真实 / 模拟」开关。
 *
 * 起因：对账单渠道被无条件绑到 MockWechatBillProvider（永远返回空账期），
 * 生产上对账天天跑、批次写 COMPLETED、把本地全部交易登记成 CHANNEL_MISSING，
 * 而界面上没有任何地方显示「你现在用的是模拟渠道」。这个问题在真实收款跑了
 * 一周之后才被发现，且只能靠 channelFileHash 恒等于 SHA256("[]") 认出来。
 *
 * 这些用例锁住：模拟模式下就绪检查必须为不健康，且文案要说清后果。
 */
describe('运行状况就绪检查：支付与对账模式', () => {
  /*
   * 统一存档/还原所有相关环境变量。
   * 早先各用例自己零散地 delete，一旦某条断言先失败、后面的清理就不会执行，
   * 于是污染同一进程里后续用例——曾出现「单独跑绿、全量跑红」的偶发失败。
   * 偶发性测试比没有测试更糟，所以这里一次性兜住。
   */
  const KEYS = [
    'PAY_MODE',
    'WX_MODE',
    'WX_TMPL_BILL_CREATED',
    'WX_TMPL_DUE_SOON',
    'WX_TMPL_OVERDUE',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** 把三类订阅消息模板一次配齐 */
  function setAllTemplates() {
    process.env.WX_TMPL_BILL_CREATED = 'a';
    process.env.WX_TMPL_DUE_SOON = 'b';
    process.env.WX_TMPL_OVERDUE = 'c';
  }

  /**
   * 构造顺序 (metrics, alerts, incidents, wxProbe, schemaVersion)。
   * 本组用例只关心 alerts.readiness() 与迁移状态，其余依赖给空对象。
   * schemaVersion 默认返回健康，避免它把别的检查项的断言带偏。
   */
  function controller(destinationConfigured: boolean, schemaOk = true) {
    const alerts = { readiness: () => ({ healthy: destinationConfigured, destinationConfigured }) };
    const schemaVersion = {
      info: jest.fn().mockResolvedValue({
        latestInImage: '20260730020000_bill_payment_unique',
        latestApplied: schemaOk ? '20260730020000_bill_payment_unique' : '20260727120000_coupon_deduction',
        pendingCount: schemaOk ? 0 : 1,
        failed: [],
        ok: schemaOk,
        detail: schemaOk ? '已应用至 20260730020000_bill_payment_unique，共 9 个' : '有 1 个迁移未应用',
      }),
    };
    return new AdminOperationsController(
      {} as never,
      alerts as never,
      {} as never,
      {} as never,
      schemaVersion as never,
    );
  }

  const cur = { tenantId: 't1' } as never;

  function checkByName(result: { checks: { name: string; healthy: boolean; detail: string }[] }, name: string) {
    const found = result.checks.find((c) => c.name === name);
    if (!found) throw new Error(`就绪检查缺少 ${name}`);
    return found;
  }

  it('wxpay 模式：支付与对账都判为健康', async () => {
    process.env.PAY_MODE = 'wxpay';
    process.env.WX_MODE = 'real';
    setAllTemplates();
    const r = (await controller(true).getReadiness(cur)) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    expect(checkByName(r, 'PAY_MODE').healthy).toBe(true);
    expect(checkByName(r, 'WX_MODE').healthy).toBe(true);
    expect(checkByName(r, 'RECONCILIATION_CHANNEL').healthy).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it('mock 模式：整体不健康，且说明「真实资金差异无法发现」', async () => {
    process.env.PAY_MODE = 'mock';
    const r = (await controller(true).getReadiness(cur)) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    expect(checkByName(r, 'PAY_MODE').healthy).toBe(false);
    const recon = checkByName(r, 'RECONCILIATION_CHANNEL');
    expect(recon.healthy).toBe(false);
    expect(recon.detail).toContain('无法发现');
    expect(r.healthy).toBe(false);
  });

  it('PAY_MODE 未配置：同样判为不健康，并把实际取值回显出来', async () => {
    delete process.env.PAY_MODE;
    const r = (await controller(true).getReadiness(cur)) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    expect(checkByName(r, 'PAY_MODE').detail).toContain('未配置');
    expect(r.healthy).toBe(false);
  });

  it('订阅消息模板：缺哪个就列出哪个，业主收不到对应提醒', async () => {
    process.env.PAY_MODE = 'wxpay';
    delete process.env.WX_TMPL_BILL_CREATED;
    delete process.env.WX_TMPL_DUE_SOON;
    process.env.WX_TMPL_OVERDUE = 'tmpl-overdue';
    const r = (await controller(true).getReadiness(cur)) as never as {
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    const c = checkByName(r as never, 'NOTIFY_TEMPLATES');
    expect(c.healthy).toBe(false);
    expect(c.detail).toContain('WX_TMPL_BILL_CREATED');
    expect(c.detail).toContain('WX_TMPL_DUE_SOON');
    expect(c.detail).not.toContain('WX_TMPL_OVERDUE');
  });

  it('三类模板都配齐时判为健康', async () => {
    process.env.PAY_MODE = 'wxpay';
    setAllTemplates();
    const r = (await controller(true).getReadiness(cur)) as never as {
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    expect(checkByName(r as never, 'NOTIFY_TEMPLATES').healthy).toBe(true);
    for (const k of ['WX_TMPL_BILL_CREATED', 'WX_TMPL_DUE_SOON', 'WX_TMPL_OVERDUE']) delete process.env[k];
  });

  it('WX_MODE 非 real 时判为不健康，并说明业主身份是伪造的', async () => {
    process.env.PAY_MODE = 'wxpay';
    process.env.WX_MODE = 'mock';
    setAllTemplates();
    const r = (await controller(true).getReadiness(cur)) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    const c = checkByName(r as never, 'WX_MODE');
    expect(c.healthy).toBe(false);
    expect(c.detail).toContain('伪造');
    expect(r.healthy).toBe(false);
  });

  it('告警目的地未配置时整体也不健康（原有行为不被新检查掩盖）', async () => {
    process.env.PAY_MODE = 'wxpay';
    process.env.WX_MODE = 'real';
    const r = (await controller(false).getReadiness(cur)) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean }[];
    };
    expect(checkByName(r as never, 'ALERT_DESTINATION').healthy).toBe(false);
    expect(r.healthy).toBe(false);
  });

  /*
   * 迁移状态兼作版本标记。容器启动命令是 `prisma migrate deploy && node main.js`，
   * 迁移失败服务起不来、成功也无处可查——此前每次发布都要临时造探针猜新版本上线了没，
   * 还判断错过一次（服务能登录但跑的还是旧版本）。
   */
  it('有未应用的迁移时整体不健康，并回显镜像水位与已应用水位', async () => {
    process.env.PAY_MODE = 'wxpay';
    process.env.WX_MODE = 'real';
    setAllTemplates();
    const r = (await controller(true, false).getReadiness(cur)) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
      schemaVersion: { latestInImage: string; latestApplied: string; pendingCount: number };
    };
    const c = checkByName(r as never, 'SCHEMA_MIGRATIONS');
    expect(c.healthy).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.schemaVersion.pendingCount).toBe(1);
    expect(r.schemaVersion.latestInImage).not.toBe(r.schemaVersion.latestApplied);
  });

  it('迁移全部应用时该项健康，且镜像水位与已应用水位一致', async () => {
    process.env.PAY_MODE = 'wxpay';
    process.env.WX_MODE = 'real';
    setAllTemplates();
    const r = (await controller(true).getReadiness(cur)) as never as {
      checks: { name: string; healthy: boolean }[];
      schemaVersion: { latestInImage: string; latestApplied: string; pendingCount: number };
    };
    expect(checkByName(r as never, 'SCHEMA_MIGRATIONS').healthy).toBe(true);
    expect(r.schemaVersion.pendingCount).toBe(0);
    expect(r.schemaVersion.latestInImage).toBe(r.schemaVersion.latestApplied);
  });
});
