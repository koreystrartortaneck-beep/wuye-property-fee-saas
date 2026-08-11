import fs from 'node:fs';
import path from 'node:path';

/**
 * 规模守卫：这些位置一旦退回「整表进内存」或「循环里发请求」，几千户就会崩或算错。
 *
 * 灰度只有 4 户，所以这一类问题全部无感——它们不是慢，而是到了某个户数就
 * 直接失败或静默给出错误数字。已修的四处各有确定的失败方式：
 *
 *   · publishBatch  逐条 enqueue，每条 2 次往返 → 3000 户 6003 次 ≈ 18s，
 *     撞 Prisma 默认 5s 事务超时 → P2028 全量回滚。而 idempotency 的 FAILED 是终态、
 *     前端复用同一个 requestId，于是「确认发布」永久失败，账单再也发不出去。
 *   · bill-import   逐行 create，约 1600 行就超时回滚，而上传大小限制换算下来
 *     能到 3000 行——一栋楼的账单表根本导不进来。
 *   · arrears.list  take: 5000 之后在内存里 reduce 求合计，12000+ 张未缴账单时
 *     「本小区欠费 ¥X」直接算错，且界面没有截断提示。
 *   · stats/today   把 14 万～43 万行账单拉进内存做 for 累加，而 today 是登录后首屏。
 *
 * 这里查的是「写法」而不是「性能」——性能没法在单测里断言，但「逐条 vs 批量」
 * 「内存累加 vs SQL 聚合」是可以从源码结构上钉住的。行为层面的断言在各自的
 * spec 里（bill-workflow / bill-import / arrears / today 都有）。
 */

const SRC = __dirname;

function read(rel: string): string {
  return fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 取某个方法体。
 *
 * 必须在下一个方法/装饰器处截断。本测试第一版用固定长度切片（slice(at, at+4000)），
 * 于是 stats 的 summary 断言实际上把紧随其后的 by-community 也切了进来——把
 * summary 改回 findMody 累加后，因为 by-community 里还有 groupBy，断言照样通过。
 * 实测注入错误时这条守卫是绿的，属假绿。
 */
function methodBody(src: string, marker: string, len = 6000): string {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error(`找不到 ${marker}——被改名了？请同步更新本测试`);
  /*
   * 从**方法体的左花括号之后**开始找边界。
   * 若直接从 marker 之后找，装饰器型 marker（如 @Get('summary')）紧跟的那个
   * `async summary(` 会被当成「下一个方法」，body 直接被截成空串——注入错误时
   * 断言全部空转（第二版就是这么错的，比第一版的固定长度切片更隐蔽）。
   */
  const open = src.indexOf('{', at);
  if (open === -1) throw new Error(`${marker} 后面找不到方法体`);
  const rest = src.slice(open, at + len);
  const next = rest.search(/\n\s*@(?:Get|Post|Patch|Put|Delete)\(|\n  (?:private\s+)?async\s+\w+\(/);
  return marker + (next === -1 ? rest : rest.slice(0, next));
}

describe('批量写入：不得逐条 create', () => {
  /*
   * 出账（bill-run.generate）是补进来的：上一批只改了发布与导入两处，而它还在逐户
   * create —— 3000 户 = 3000 次往返，每日 cron 对 4 条规则串行跑会占住事件循环
   * 30 余秒。守卫当时只列了那两处，所以这个漏改没有被发现。
   * 这条教训值得记：白名单式的守卫只保护它列出的东西，漏列等于没有守卫。
   */
  const CASES = [
    { file: 'billing/bill-workflow.service.ts', marker: 'async publishBatch', what: '发布批次的 Outbox 事件' },
    { file: 'billing/bill-import.service.ts', marker: 'async confirm', what: '导入的账单行' },
    { file: 'billing/bill-run.service.ts', marker: 'async generate', what: '规则出账的账单' },
  ];

  it('都用 createMany 并带 skipDuplicates（承接原有的幂等语义）', () => {
    const offenders: string[] = [];
    for (const c of CASES) {
      const body = methodBody(read(c.file), c.marker);
      if (!/createMany\(/.test(body)) offenders.push(`${c.what}：没有用 createMany`);
      if (!/skipDuplicates:\s*true/.test(body)) {
        offenders.push(`${c.what}：createMany 缺 skipDuplicates，会丢掉原来靠 P2002/dedupKey 实现的幂等`);
      }
    }
    if (offenders.length) throw new Error('批量写入退化：\n  ' + offenders.join('\n  '));
    expect(offenders).toEqual([]);
  });

  it('事务显式设 timeout（默认 5s 在几百户/上千行时就会回滚）', () => {
    const offenders: string[] = [];
    /*
     * 出账不在事务里（所以不会 P2028 回滚，只是慢），这一条只适用于事务内的两处。
     * 刻意显式排除而不是让它「碰巧通过」——后者在出账将来被包进事务时会漏掉。
     */
    const TX_CASES = CASES.filter((c) => c.marker !== 'async generate');
    for (const c of TX_CASES) {
      const body = methodBody(read(c.file), c.marker);
      const m = body.match(/timeout:\s*(\d+)_?(\d*)/);
      if (!m) {
        offenders.push(`${c.what}：$transaction 没传 timeout，走 Prisma 默认 5000ms`);
        continue;
      }
      const ms = Number(`${m[1]}${m[2]}`);
      if (ms < 30_000) offenders.push(`${c.what}：timeout 只有 ${ms}ms，应 ≥30000（与 outbox.service 对齐）`);
    }
    if (offenders.length) throw new Error('事务超时设置不足：\n  ' + offenders.join('\n  '));
    expect(offenders).toEqual([]);
  });

  it('发布批次不再在事务外逐条发通知（那是 3000 次串行微信调用）', () => {
    const body = methodBody(read('billing/bill-workflow.service.ts'), 'async publishBatch');
    expect(body).not.toContain('onBillCreated');
  });
});

describe('聚合下推：不得把账单整表拉进内存累加', () => {
  const CASES = [
    { file: 'admin/stats.controller.ts', marker: "@Get('summary')", what: '收缴统计合计' },
    { file: 'admin/stats.controller.ts', marker: "@Get('by-community')", what: '分小区收缴统计' },
    { file: 'admin/today.controller.ts', marker: 'async overview', what: '首屏「今天」' },
    { file: 'billing/arrears.controller.ts', marker: 'async list', what: '欠费清单' },
  ];

  it('都改用 groupBy / aggregate，且不再对账单 findMany', () => {
    const offenders: string[] = [];
    for (const c of CASES) {
      const body = methodBody(read(c.file), c.marker, 4000);
      if (!/groupBy\(|aggregate\(/.test(body)) {
        offenders.push(`${c.what}：没有用 groupBy/aggregate`);
      }
      // 允许为「当页那几百户」查明细，但不允许对 bill 无 where 限定地 findMany
      if (/bill\.findMany\(\s*\{\s*where:\s*\{\s*(period|status)/.test(body)) {
        offenders.push(`${c.what}：仍在对账单表 findMany 后于内存累加`);
      }
    }
    if (offenders.length) throw new Error('聚合退化为内存累加：\n  ' + offenders.join('\n  '));
    expect(offenders).toEqual([]);
  });

  it('欠费清单的合计不受明细截断影响', () => {
    const body = methodBody(read('billing/arrears.controller.ts'), 'async list', 5000);
    // 合计必须在 slice 之前算
    const totalAt = body.indexOf('const totalCents');
    const sliceAt = body.indexOf('.slice(0, ArrearsService.LIST_CAP)');
    expect(totalAt).toBeGreaterThan(-1);
    expect(sliceAt).toBeGreaterThan(-1);
    expect(totalAt).toBeLessThan(sliceAt);
    // 截断要如实告知，不能静默
    expect(body).toContain('truncated');
  });
});

describe('循环里不得发数据库请求', () => {
  it('出账的抄表读数一次批量取回，不是每户一次 getDiff', () => {
    const src = read('billing/bill-run.service.ts');
    const body = methodBody(src, 'async generate', 14000);
    /*
     * 原实现在 for (const house of houses) 里调 this.meter.getDiff(house.id, ...)，
     * 3000 户就是 3000 次额外往返。每日 02:00 的 cron 串行跑 4 条规则，
     * 单小区占住事件循环 45-75 秒；手动触发则一个请求挂 9-18 秒、很可能网关超时，
     * 而后台仍在继续写，前端已认定失败。
     */
    expect(body).toMatch(/meterReading\.findMany\([\s\S]*?houseId:\s*\{\s*in:/);
    expect(body).not.toMatch(/this\.meter\.getDiff\(/);
  });

  it('批量催缴一次落 Outbox，不在请求内逐笔发微信', () => {
    const body = methodBody(read('billing/arrears.controller.ts'), 'async dun', 5000);
    expect(body).toMatch(/outboxEvent\.createMany/);
    expect(body).toMatch(/skipDuplicates:\s*true/);
    // 请求内一旦再调 notifier，就回到 3600 次串行调用 ≈ 720 秒
    expect(body).not.toContain('this.notifier.onReminder');
  });

  it('缺上期读数一律跳过，绝不按 0 计', () => {
    /*
     * 小区上线首月水表已经用了多年（比如读数 1234），按 0 计会把累计读数当本期用量：
     * 单价 3.5 元/吨时开出 ¥4319，而该户当月实际应约 ¥105。这不是边界情况，
     * 是新小区上线的必然路径。批量预取改写时必须保留这个判定。
     */
    const body = methodBody(read('billing/bill-run.service.ts'), 'async generate', 14000);
    expect(body).toMatch(/prevValue === null/);
    // 也不能写成 ?? 0 / || 0 这类兜底
    expect(body).not.toMatch(/prevValue\s*(\?\?|\|\|)\s*0/);
  });
});

/**
 * BillRun.skippedDetail 不得无上限写进 Json 列。
 *
 * 抄表规则的**首月会跳过全部房屋**——缺上期基准读数时 getDiff 返回 null，
 * calcOne 以 METER_READING_MISSING 跳过。这不是边界情况，是新小区上线的必然路径
 * （水表已经用了多年，第一期只能作为基期）。
 * 3000 户 = 3000 条明细 × 约 90 字节 = 单行 Json 约 270KB，
 * 而 GET /admin/bill-runs 原先用 include 返回整行、管理端按 pageSize=200 拉，
 * 理论响应体 54MB。
 */
describe('跳过明细必须汇总后落库', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { summarizeSkipped } = require('./billing/bill-run.service') as {
    summarizeSkipped(d: Array<{ houseId: string; code: string; reason: string }>): {
      total: number;
      truncated: boolean;
      byReason: Record<string, number>;
      samples: Array<{ code: string }>;
    };
  };

  function details(n: number, reason = 'METER_READING_MISSING') {
    return Array.from({ length: n }, (_, i) => ({
      houseId: `h${i}`,
      code: `1-${String(i).padStart(4, '0')}`,
      reason,
    }));
  }

  it('3000 户全跳过时样本被截断，但总数与原因分布是全量真值', () => {
    const out = summarizeSkipped(details(3000));
    expect(out.total).toBe(3000);
    expect(out.truncated).toBe(true);
    expect(out.samples.length).toBeLessThanOrEqual(50);
    // 「2998 户缺读数」这个数字必须准，它是物业判断问题范围的唯一依据
    expect(out.byReason.METER_READING_MISSING).toBe(3000);
  });

  it('落库体积可控（3000 户不得超过 8KB）', () => {
    const bytes = Buffer.byteLength(JSON.stringify(summarizeSkipped(details(3000))), 'utf8');
    if (bytes > 8192) {
      throw new Error(
        `3000 户全跳过时 skippedDetail 序列化后 ${bytes} 字节。` +
          '这一列会被 GET /admin/bill-runs 按 pageSize=200 一起拉走，必须保持在数 KB 量级。',
      );
    }
    expect(bytes).toBeLessThan(8192);
  });

  it('少量跳过时样本完整，不做无谓截断', () => {
    const out = summarizeSkipped(details(3));
    expect(out.truncated).toBe(false);
    expect(out.samples).toHaveLength(3);
  });

  it('多种原因分别计数（物业要能看出是缺面积还是缺读数）', () => {
    const out = summarizeSkipped([...details(10, 'AREA_MISSING'), ...details(5, 'METER_READING_MISSING')]);
    expect(out.byReason).toEqual({ AREA_MISSING: 10, METER_READING_MISSING: 5 });
    expect(out.total).toBe(15);
  });

  it('列表接口不返回 skippedDetail（Json 列不该跟着分页一起拉）', () => {
    const src = read('billing/bill-run.controller.ts');
    const at = src.indexOf('billRun.findMany');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('}),', at));
    // 必须用 select 白名单，而不是 include 整行
    expect(body).toContain('select:');
    expect(body).not.toContain('skippedDetail');
  });
});

/**
 * 批量写的 data 不得用 `as never` / `Record<string, unknown>` 绕过类型检查。
 *
 * 这是我这轮改造时**两次**踩到的同一个模式（bill-run 与 houses 各一处）：
 * 把逐条 create 换成 createMany 时，因为租户扩展会自动注入 tenantId、
 * 而 Prisma 的 CreateManyInput 要求它必填，于是顺手写了 `as never` 让它过。
 *
 * 代价是 Prisma 对**其余所有字段**的校验一并失效 —— 字段名拼错、漏必填字段都不报错。
 * 而 createMany 是批量写：错一个字段名就是几千行脏数据，且不会有任何运行时提示。
 * 实测在收紧类型后注入「houseId 写成 housId」「删掉必填的 period」，tsc 立刻报错；
 * 用 as never 时两者都静默通过。
 *
 * 正确写法是只对 tenantId 留出口：
 *   Array<Omit<Prisma.XCreateManyInput, 'tenantId'>>  或
 *   ... as Prisma.XCreateManyInput[]
 * 后者仍是断言，但 TS 会做「类型是否充分重叠」的检查，拼错字段名照样报 TS2352。
 */
describe('批量写不得绕过类型检查', () => {
  it('createMany 的 data 不用 as never', () => {
    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
      }
      return out;
    };
    for (const file of walk(SRC)) {
      const src = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // 取每个 createMany( 之后的一小段，看 data 那一行有没有 as never
      for (const m of src.matchAll(/createMany\(\s*\{/g)) {
        const seg = src.slice(m.index as number, (m.index as number) + 600);
        const dataLine = /data:\s*([^\n]*)/.exec(seg)?.[1] ?? '';
        if (/as never/.test(dataLine)) {
          offenders.push(`${path.relative(SRC, file)} → data: … as never`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        'createMany 的 data 用了 as never，Prisma 对所有字段的校验一并失效 ——' +
          '字段名拼错、漏必填字段都不报错，而批量写错一个字段就是几千行脏数据：\n  ' +
          offenders.join('\n  ') +
          "\n改用 Omit<Prisma.XCreateManyInput, 'tenantId'>（租户 ID 由租户扩展注入）。",
      );
    }
    expect(offenders).toEqual([]);
  });

  it('攒批数组不用 Record<string, unknown>（等于放弃全部字段检查）', () => {
    const offenders: string[] = [];
    for (const rel of ['billing/bill-run.service.ts', 'billing/bill-import.service.ts', 'admin/houses.controller.ts']) {
      const src = read(rel);
      if (/const pending: Array<Record<string, unknown>>/.test(src)) {
        offenders.push(`${rel} → pending 用了 Record<string, unknown>`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
