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
  const saved = process.env.PAY_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAY_MODE;
    else process.env.PAY_MODE = saved;
  });

  /** 构造顺序是 (metrics, alerts, incidents)；本用例只需要 alerts.readiness() */
  function controller(destinationConfigured: boolean) {
    const alerts = { readiness: () => ({ healthy: destinationConfigured, destinationConfigured }) };
    return new AdminOperationsController({} as never, alerts as never, {} as never);
  }

  const cur = { tenantId: 't1' } as never;

  function checkByName(result: { checks: { name: string; healthy: boolean; detail: string }[] }, name: string) {
    const found = result.checks.find((c) => c.name === name);
    if (!found) throw new Error(`就绪检查缺少 ${name}`);
    return found;
  }

  it('wxpay 模式：支付与对账都判为健康', () => {
    process.env.PAY_MODE = 'wxpay';
    const r = controller(true).getReadiness(cur) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    expect(checkByName(r, 'PAY_MODE').healthy).toBe(true);
    expect(checkByName(r, 'RECONCILIATION_CHANNEL').healthy).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it('mock 模式：整体不健康，且说明「真实资金差异无法发现」', () => {
    process.env.PAY_MODE = 'mock';
    const r = controller(true).getReadiness(cur) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    expect(checkByName(r, 'PAY_MODE').healthy).toBe(false);
    const recon = checkByName(r, 'RECONCILIATION_CHANNEL');
    expect(recon.healthy).toBe(false);
    expect(recon.detail).toContain('无法发现');
    expect(r.healthy).toBe(false);
  });

  it('PAY_MODE 未配置：同样判为不健康，并把实际取值回显出来', () => {
    delete process.env.PAY_MODE;
    const r = controller(true).getReadiness(cur) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean; detail: string }[];
    };
    expect(checkByName(r, 'PAY_MODE').detail).toContain('未配置');
    expect(r.healthy).toBe(false);
  });

  it('告警目的地未配置时整体也不健康（原有行为不被新检查掩盖）', () => {
    process.env.PAY_MODE = 'wxpay';
    const r = controller(false).getReadiness(cur) as never as {
      healthy: boolean;
      checks: { name: string; healthy: boolean }[];
    };
    expect(checkByName(r as never, 'ALERT_DESTINATION').healthy).toBe(false);
    expect(r.healthy).toBe(false);
  });
});
