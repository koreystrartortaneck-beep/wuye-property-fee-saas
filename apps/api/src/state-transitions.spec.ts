import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 状态流转必须是条件更新。
 *
 * 这条守卫的由来：同一个「先查状态、再无条件 update」的形状，我在一天里撞到了四次 ——
 *   · 支付侧的 consumeCouponInTx：一直是对的（条件 updateMany + count 校验）
 *   · 卡券核销 verify：漏了 → 两个收银台同时扫，礼品券发两份
 *   · 访客核销 verify：漏了 → 两个岗亭同时扫，两个人都进来
 *   · 绑定审核 review：漏了 → 两名管理员同时点通过与驳回，后写的静默覆盖前写的，
 *     而 reviewedBy 记的是后者。ACTIVE 绑定等于开放该户账单与缴费权限。
 *
 * 「做对了一处」完全不代表做对了全部，而每次都是等撞到才修。
 * 所以把「同类代码全查一遍」变成测试：它自己扫全库，新写的读后写会被拦住。
 *
 * 豁免必须写在下面的清单里并注明理由 —— 不是所有状态更新都需要乐观锁，
 * 但「为什么不需要」得有人想过一次。
 */

const SRC = __dirname;

/** 显式豁免：键是 `相对路径:方法名`，值是理由（会被断言要求非空） */
const EXEMPT: Record<string, string> = {
  'admin/houses.controller.ts:update':
    '先读一次只为算审计差异(哪个字段从什么改成什么),写的是绝对值而不是状态流转;' +
    '两名管理员同时改同一套房仍是后写覆盖前写 —— 这一点在加审计之前就是如此,' +
    '而现在至少两次修改都留下了痕迹,「谁把面积改了」查得出来',
  'admin/admin-auth.controller.ts:login':
    '更新的是 lastLoginAt/失败计数，不是状态机；并发重复写同一个时间戳无害',
  'billing/meter.controller.ts:createReading':
    '用的是 upsert（唯一键 houseId+meterType+period），冲突由数据库收口，不存在读后写',
  'operations/alert.service.ts:emit':
    '累加 occurrences 用的是 increment 原子操作；告警计数少算一次不影响任何资金或权限',
  'operations/incident.service.ts:openOrReopen':
    '同上，且事件本身按 dedupKey 收敛，重复开同一个事件不产生副作用',
  'owner/owner-houses.controller.ts:applyBinding':
    '唯一约束 (wxUserId, houseId) 已保证不会重复；并发的那次撞 P2002 后映射为 BINDING_EXISTS',
  'services/services.service.ts:cancelOrder':
    '业主取消自己的预约，重复取消结果相同且无资金动作（简版服务不含在线支付）',
  'tickets/tickets.service.ts:rate':
    '评分是列而非计数器，重复提交最后一次生效；已有 rating !== null 的前置拦截，无资金影响',
  'visitors/visitors.service.ts:cancel':
    '业主取消自己的通行码，重复取消结果相同；真正需要乐观锁的是 verify（已加）',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts') && !e.name.includes('.spec.')) out.push(p);
  }
  return out;
}

/** 从方法头开始做真括号匹配取出方法体。定长切片会切进下一个方法（本仓踩过两次） */
function methods(code: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /\n {2}(?:private |public |protected )?(?:async )?(\w+)\s*\([^)]*\)[^{;]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push({ name: m[1], body: code.slice(open + 1, i) });
          break;
        }
      }
    }
  }
  return out;
}

function findReadThenWrite(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const raw = readFileSync(file, 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const { name, body } of methods(code)) {
      const readsStatus = /\.(findUnique|findFirst)\(/.test(body) && /\bstatus\b/.test(body);
      const uncondUpdate = /\.update\(\s*\{\s*where:\s*\{\s*(id|tenantId_id)\b/.test(body);
      const hasConditional = /updateMany\(\s*\{\s*where:\s*\{[^}]*status/.test(body);
      if (readsStatus && uncondUpdate && !hasConditional) {
        found.push(`${file.slice(SRC.length + 1)}:${name}`);
      }
    }
  }
  return found.sort();
}

describe('状态流转必须是条件更新', () => {
  it('解析器能找到方法（写坏时返回空会让主断言永真）', () => {
    const code = readFileSync(join(SRC, 'visitors/visitors.service.ts'), 'utf8');
    const names = methods(code).map((m) => m.name);
    expect(names).toContain('verify');
    expect(names).toContain('create');
  });

  it('检测器能认出「读状态后无条件更新」的形状（正向对照）', () => {
    /*
     * 用合成代码验证检测逻辑本身 —— 否则改一行就能把整条守卫悄悄关掉而测试仍全绿
     * （本仓已经在另一条守卫上被注入验证抓到过一次）。
     */
    const bad = `
  async verify(id: string) {
    const row = await this.prisma.t.pass.findUnique({ where: { id } });
    if (row.status !== 'ACTIVE') throw new Error('x');
    return this.prisma.t.pass.update({ where: { id }, data: { status: 'USED' } });
  }
`;
    const good = `
  async verify(id: string) {
    const row = await this.prisma.t.pass.findUnique({ where: { id } });
    if (row.status !== 'ACTIVE') throw new Error('x');
    const done = await this.prisma.t.pass.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'USED' } });
    if (done.count !== 1) throw new Error('raced');
    return row;
  }
`;
    const detect = (code: string) =>
      methods(code).some(
        ({ body }) =>
          /\.(findUnique|findFirst)\(/.test(body) &&
          /\bstatus\b/.test(body) &&
          /\.update\(\s*\{\s*where:\s*\{\s*id\b/.test(body) &&
          !/updateMany\(\s*\{\s*where:\s*\{[^}]*status/.test(body),
      );
    expect(detect(bad)).toBe(true);
    expect(detect(good)).toBe(false);
  });

  it('没有未豁免的读后写', () => {
    const offenders = findReadThenWrite().filter((k) => !(k in EXEMPT));
    expect(offenders).toEqual([]);
  });

  it('豁免清单不得有空理由，也不得留下已消失的条目', () => {
    /*
     * 空理由等于没想过；而已消失的条目会掩盖新出现的同名问题
     * （方法改名或被修好之后，清单里的旧条目会一直豁免着一个不存在的东西）。
     */
    const current = new Set(findReadThenWrite());
    const stale: string[] = [];
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim().length).toBeGreaterThan(10);
      if (!current.has(key)) stale.push(key);
    }
    expect(stale).toEqual([]);
  });

  it('资金与权限相关的核销/审批都已用条件更新', () => {
    // 正向钉住这四处：它们是这条守卫的由来，不能因为重构悄悄退回去
    const cases: Array<[string, string]> = [
      ['coupons/coupons.service.ts', 'verify'],
      ['visitors/visitors.service.ts', 'verify'],
      ['admin/bindings.controller.ts', 'review'],
      ['payment/payment.service.ts', 'consumeCouponInTx'],
    ];
    for (const [file, method] of cases) {
      const code = readFileSync(join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const body = methods(code).find((m) => m.name === method)?.body;
      expect(body).toBeDefined();
      expect(body).toMatch(/updateMany\(/);
      expect(body).toMatch(/count !== 1/);
    }
  });
});
