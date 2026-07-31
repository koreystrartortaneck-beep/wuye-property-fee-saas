import fs from 'node:fs';
import path from 'node:path';

/**
 * 资金操作的两道控制：谁能做（角色）、做了留痕（审计）。
 *
 * 起因（全量排查发现）：
 *
 *   1) RolesGuard 的规则是「没标 @Roles 就放行所有已登录管理员」。而退款、冲正这两个
 *      **把钱退出去**的端点都没标，等于任何管理员账号都能动钱。当时生产只有一个
 *      TENANT_ADMIN 账号所以没有实际风险，但 schema 里 STAFF 角色是存在的——一旦为
 *      收费员开了 STAFF 账号就立刻变成真实越权。
 *
 *   2) 微信支付成功入账（applyWxPaySuccess）没有写审计。生产审计日志 73 条里有
 *      「业主下单」Payment/CREATE、「线下收款」Payment/PAY、「退款」Refund/REFUND，
 *      唯独没有「钱真正到账」这一步：查一笔钱时审计链会从 CREATE 直接跳到 REFUND。
 *      而「系统动作也写审计」本就是既有约定（退款终态、发票冲红都用 SYSTEM），
 *      所以这是遗漏而非设计选择。
 */

const SRC = __dirname;

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** 去掉注释，避免把说明文字里提到的标记当成真实代码 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('资金出账端点必须限制角色', () => {
  /**
   * 只列「把钱退出去 / 把已收的钱作废」的端点。
   *
   * 刻意不包含线下现金核销与出账：核销是收费员的日常工作，且它只会把账单从未缴
   * 改成已缴、不会把钱退出去，风险方向相反；出账影响应收但不动已收的钱。
   */
  const MONEY_OUT = [
    { file: 'payment/admin-refund.controller.ts', marker: '@Post()', what: '发起退款' },
    { file: 'payment/admin-payment.controller.ts', marker: "@Post(':orderNo/reverse-offline')", what: '冲正线下缴费' },
  ];

  it('退款与冲正都标了 @Roles，不会落进「无标注即放行」', () => {
    const offenders: string[] = [];
    for (const { file, marker, what } of MONEY_OUT) {
      const src = stripComments(read(file));
      const at = src.indexOf(marker);
      if (at === -1) {
        offenders.push(`${file} 找不到端点 ${marker}（${what}）——端点被改名了？请同步更新本测试`);
        continue;
      }
      // @Roles 必须紧挨在该端点装饰器之前（同一段装饰器块内）
      const before = src.slice(Math.max(0, at - 200), at);
      if (!before.includes('@Roles(')) {
        offenders.push(`${file} 的「${what}」没有 @Roles，任何已登录管理员都能动钱`);
      }
    }
    if (offenders.length) {
      throw new Error('资金出账端点缺少角色限制：\n  ' + offenders.join('\n  '));
    }
    expect(offenders).toEqual([]);
  });

  it('RolesGuard 的语义没变：无标注即放行，SUPER_ADMIN 恒通过', () => {
    const guard = read('auth/roles.decorator.ts');
    // 这两条是上面那条用例成立的前提；若语义改了，上面的断言就失去意义
    expect(guard).toContain('if (!required || required.length === 0) return true');
    expect(guard).toContain("if (current.role === 'SUPER_ADMIN') return true");
  });
});

describe('资金入账必须留痕', () => {
  it('微信支付成功入账写审计，且在同一事务内', () => {
    const src = read('payment/payment.service.ts');
    const at = src.indexOf('applyWxPaySuccess');
    expect(at).toBeGreaterThan(-1);
    // 取该方法之后的一段，确认审计调用在其中
    const body = src.slice(at, at + 4000);
    expect(body).toContain('audit.append');
    expect(body).toContain("actorType: 'SYSTEM'");
    expect(body).toContain("action: 'PAY'");
    // 必须把确认来源记下来：区分「微信推过来的」还是「我们查出来的」。
    // 注意不能写 toContain('source')——它是 'resourceType' 的子串（re-source-Type），
    // 任何 audit.append 都带 resourceType，那条断言恒为真。实测删掉 source 字段后
    // 本文件 4 个用例全绿。同一类子串陷阱本会话已犯第二次。
    expect(body).toMatch(/\bsource\s*[,:]/);
    // 第二个参数传 tx 才是同事务；审计与入账不能一个成一个不成
    expect(body).toMatch(/audit\.append\(\s*\{[\s\S]*?\},\s*tx,\s*\)/);
  });

  it('线下核销与退款终态原有的审计没有被破坏', () => {
    expect(read('payment/offline-payment.service.ts')).toContain('audit.append');
    expect(read('payment/refund.service.ts')).toContain('audit.append');
  });
});
