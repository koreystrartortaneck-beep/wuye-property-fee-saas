import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BillImportService } from './bill-import.service';
import { BillRunService } from './bill-run.service';

/**
 * 重复收款的四条路径。
 *
 * 每一条都会让同一户在同一账期为同一笔费用产生两张可付账单，或让账单合计超过
 * 应收总额。其中 A5 不是推演——生产库里已经发生：两户各有两张 2026-07 物业费
 * 同时待缴（「2026年07月物业费」¥0.01 与「住宅物业费 2026-07」¥222.50）。
 *
 * 注意维度：同房同期允许多张账单（物业费、占位费、水费各一张），唯一键
 * @@unique([ruleId, houseId, period]) 就是按**费用项**去重的。按账期去重会直接
 * 打断多费项计费——这一点是在核对生产数据时才发现的，此前的修复方案是错的。
 */

const SRC = __dirname;

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(rel: string): string {
  return strip(readFileSync(join(SRC, rel), 'utf8'));
}

describe('A4 重开账单：守卫维度必须是「房+期+费用项」', () => {
  const src = read('bill-workflow.service.ts');
  const body = src.slice(src.indexOf('async reissueBill'), src.indexOf('async reissueBill') + 4000);

  it('不再按 replacesBillId 判重（挡不住链式重开）', () => {
    /*
     * 原守卫查 { replacesBillId: bill.id, status notIn [CANCELED] }，即
     * 「一张原账单只能有一张存活替代账单」。链式重开可绕过：
     *   A 作废→重开得 B；B 作废→重开 B 得 C；再重开 A（B 已 CANCELED 被排除）→ 得 D
     * C 与 D 同为 UNPAID、同房同期同费用项，业主两张都能付。
     */
    expect(body).not.toMatch(/replacesBillId:\s*bill\.id[\s\S]{0,200}?status:\s*\{\s*notIn/);
  });

  it('按房屋+账期+存活状态查同期账单', () => {
    expect(body).toMatch(/houseId:\s*bill\.houseId/);
    expect(body).toMatch(/period:\s*bill\.period/);
    // REFUNDED 不算存活：它是「钱已退回」的终态，且它本身可被重开
    expect(body).toMatch(/notIn:\s*\['CANCELED',\s*'REFUNDED'\]/);
  });

  it('比对的是有效费用项（重开后 ruleId 置空，原 ruleId 在 snapshot）', () => {
    expect(body).toContain('originalRuleId');
    expect(body).toMatch(/effectiveRuleOf/);
  });
});

describe('A1 公摊重跑：已出账的账期必须拒绝', () => {
  /*
   * 这里必须做行为断言。本条守卫的第一版只 grep 源码里有没有
   * 'SHARE_ALREADY_GENERATED' 这个字样，于是把判断改成 `if (false)` 之后
   * 16 个用例照样全绿——正是本会话反复栽的「复刻/grep 式无效守卫」。
   *
   * allocateShare 按「当前」房屋集合把池子分完。重跑时已有账单撞唯一键被幂等跳过、
   * 保留旧金额，新增房屋按新分摊拿钱，两套分摊叠加：
   *   池 ¥300 / 4 户 = 每户 ¥75；加第 5 户重跑 → 新分摊 ¥60/户，
   *   前 4 户仍 ¥75 + 第 5 户 ¥60 = ¥360，超收 ¥60。户数越多超得越多，
   *   且完全静默——出账页只显示「跳过 4 户」。
   */
  const RULE = {
    id: 'r-share',
    communityId: 'c1',
    name: '电梯电费公摊',
    ruleType: 'SHARE',
    houseType: 'RESIDENCE',
    dueDays: 15,
    enabled: true,
    params: { shareBy: 'AREA' },
  };

  function makeService(existingBills: Array<{ id: string; status: string }>) {
    const created: unknown[] = [];
    const runUpdates: Array<Record<string, unknown>> = [];
    const t = {
      feeRule: { findUnique: jest.fn().mockResolvedValue(RULE) },
      billBatch: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'DRAFT' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      billRun: {
        upsert: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn((args: { data: Record<string, unknown> }) => {
          runUpdates.push(args.data);
          return Promise.resolve({});
        }),
      },
      house: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'h1', code: '1-101', area: { toString: () => '100' } },
          { id: 'h2', code: '1-102', area: { toString: () => '100' } },
        ]),
      },
      sharePool: {
        findUnique: jest.fn().mockResolvedValue({ totalAmount: { toString: () => '300.00' } }),
      },
      bill: {
        findMany: jest.fn().mockResolvedValue(existingBills),
        create: jest.fn((args: unknown) => {
          created.push(args);
          return Promise.resolve({ id: `b-${created.length}` });
        }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } }),
      },
    };
    const service = new BillRunService({ t, raw: t } as never, { getDiff: jest.fn() } as never);
    return { service, created, runUpdates, t };
  }

  it('该账期已有存活账单时：整批 FAILED，一张账单都不创建', async () => {
    const { service, created, runUpdates } = makeService([
      { id: 'b-old-1', status: 'UNPAID' },
      { id: 'b-old-2', status: 'UNPAID' },
    ]);
    const res = await service.generate('r-share', '2026-07');
    expect(res.status).toBe('FAILED');
    expect(res.generated).toBe(0);
    expect(created).toHaveLength(0);
    // 原因要写进 skippedDetail，物业在出账页才看得到为什么失败
    const detail = JSON.stringify(runUpdates);
    expect(detail).toContain('SHARE_ALREADY_GENERATED');
    expect(detail).toContain('先作废');
  });

  it('已有账单里含已收款时，提示要点明（涉及退款，处理方式不同）', async () => {
    const { service, runUpdates } = makeService([{ id: 'b-old-1', status: 'PAID' }]);
    await service.generate('r-share', '2026-07');
    expect(JSON.stringify(runUpdates)).toContain('已产生收款');
  });

  it('该账期没有存活账单时正常分摊，合计等于池子', async () => {
    const { service, created } = makeService([]);
    const res = await service.generate('r-share', '2026-07');
    expect(res.status).not.toBe('FAILED');
    expect(created).toHaveLength(2);
    const amounts = created.map((c) => (c as { data: { amount: string } }).data.amount);
    const totalCents = amounts.reduce((sum, a) => sum + Math.round(Number(a) * 100), 0);
    expect(totalCents).toBe(30000); // ¥300.00，不多不少
  });

  it('已作废的账单不算存活（作废后应当可以重出）', async () => {
    // 服务查询时就带了 status notIn CANCELED，故 mock 返回空即代表「只有作废账单」
    const { service, created } = makeService([]);
    const res = await service.generate('r-share', '2026-07');
    expect(res.status).not.toBe('FAILED');
    expect(created).toHaveLength(2);
  });

  it('查询条件限定本规则本账期且排除已作废', async () => {
    const { service, t } = makeService([]);
    await service.generate('r-share', '2026-07');
    expect(t.bill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ruleId: 'r-share',
          period: '2026-07',
          status: { notIn: ['CANCELED'] },
        }),
      }),
    );
  });
});

describe('A3 抄表：乱序补录与修正上期不得重复计费', () => {
  const src = read('meter.controller.ts');
  const body = src.slice(src.indexOf('async createReading'), src.indexOf('async getDiff'));

  it('查后一期读数，而不只查上一期', () => {
    // 原实现只有 period: { lt: dto.period }
    expect(body).toMatch(/period:\s*\{\s*gt:\s*dto\.period\s*\}/);
  });

  it('本期读数不得大于后一期（否则后一期用量为负）', () => {
    expect(body).toMatch(/dto\.value\s*>\s*Number\(next\.value\)/);
  });

  it('写入后同步刷新后一期的 prevValue', () => {
    /*
     * getDiff 用「本期 value − 本期 prevValue 快照」，而 prevValue 只在 create 时
     * 写一次。补录 2 月后，3 月的 prevValue 仍停在 1 月的值：
     *   1月=100、3月=300（用量 200）；补录 2月=200（用量 100）
     *   → 合计计费 300，而 100→300 的真实用量只有 200，业主被重复收 100 单位。
     */
    expect(body).toMatch(/meterReading\.update\([\s\S]*?prevValue:\s*saved\.value/);
  });

  it('后一期已出账时拒绝改动（已发出的账单不会因改快照而修正）', () => {
    expect(body).toMatch(/bill\.findFirst/);
    expect(body).toContain('已出账');
  });
});

describe('A5 导入：同房同期已有待缴账单必须提示', () => {
  const src = read('bill-import.service.ts');

  it('查询不再只看已缴状态', () => {
    // 原实现：status: { in: PAID_LIKE_STATUSES }，DRAFT/UNPAID 一声不响
    expect(src).not.toMatch(/period,\s*status:\s*\{\s*in:\s*PAID_LIKE_STATUSES\s*\}/);
    expect(src).toMatch(/notIn:\s*\['CANCELED'\]/);
  });

  it('待缴冲突是 warn 而非 error（多费项导入是合法的）', () => {
    expect(src).toMatch(/code:\s*'UNPAID_EXISTS'/);
    expect(src).toMatch(/severity:\s*'warn'/);
  });

  it('valid 只由 error 级问题决定', () => {
    expect(src).toMatch(/errors\.length === 0/);
    expect(src).not.toMatch(/valid:\s*issues\.length === 0/);
  });

  /**
   * 行为断言：真实调用 validateRows。
   * 静态断言只能保证代码长什么样，保证不了它算得对——本会话已因「复刻式守卫」
   * 栽过三次，凡能跑真实代码的地方就不用 grep。
   */
  function makeService(sameperiod: Array<{ houseId: string; title: string; amount: string; status: string }>) {
    const prisma = {
      raw: {
        house: { findMany: jest.fn().mockResolvedValue([{ id: 'h1', code: '1-1-101' }]) },
        bill: { findMany: jest.fn().mockResolvedValue(sameperiod) },
      },
    };
    return new BillImportService(prisma as never, {} as never);
  }

  const row = { rowNo: 1, houseCode: '1-1-101', amount: '222.50', title: '' };

  it('本期已有未缴账单：可导入但标记需确认，且提示里带出标题与金额', async () => {
    const svc = makeService([{ houseId: 'h1', title: '住宅物业费 2026-07', amount: '222.50', status: 'UNPAID' }]);
    const [r] = await svc.validateRows('c1', '2026-07', [row], '2026年07月物业费');
    expect(r.valid).toBe(true); // 不阻断
    expect(r.needsReview).toBe(true);
    expect(r.issues.some((i) => i.code === 'UNPAID_EXISTS' && i.severity === 'warn')).toBe(true);
    expect(r.issues.find((i) => i.code === 'UNPAID_EXISTS')?.message).toContain('住宅物业费 2026-07');
    expect(r.issues.find((i) => i.code === 'UNPAID_EXISTS')?.message).toContain('222.50');
  });

  it('本期已有已缴账单：仍然阻断（原有行为不能退化）', async () => {
    const svc = makeService([{ houseId: 'h1', title: '住宅物业费 2026-07', amount: '222.50', status: 'PAID' }]);
    const [r] = await svc.validateRows('c1', '2026-07', [row], '默认');
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'PAID_CONFLICT')).toBe(true);
  });

  it('本期已作废的账单不提示（作废不构成待收）', async () => {
    const svc = makeService([]);
    const [r] = await svc.validateRows('c1', '2026-07', [row], '默认');
    expect(r.valid).toBe(true);
    expect(r.needsReview).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('摘要里给出需确认的行数，物业才看得见', async () => {
    const svc = makeService([{ houseId: 'h1', title: '住宅物业费 2026-07', amount: '1.00', status: 'DRAFT' }]);
    const rows = await svc.validateRows('c1', '2026-07', [row], '默认');
    const summary = (svc as unknown as { summarize(r: typeof rows): { needsReview: number; valid: number } }).summarize(rows);
    expect(summary.needsReview).toBe(1);
    expect(summary.valid).toBe(1);
  });
});
