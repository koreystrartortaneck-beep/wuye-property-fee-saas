import fs from 'node:fs';
import path from 'node:path';

/**
 * 守护「不得静默退回 Mock 实现」。
 *
 * 这个项目已经因为同一类事故栽过两次：
 *
 *   1) ReconciliationModule 把 WECHAT_BILL_PROVIDER 无条件绑到
 *      MockWechatBillProvider（永远返回空账期）。生产上对账天天在跑、批次写
 *      COMPLETED、把本地全部交易登记成「微信侧缺失」差异，而真实资金差异一次也
 *      发现不了。线上指纹：channelFileHash 恒为 SHA256("[]")、耗时 15–34ms。
 *
 *   2) WxModule 写成 `WX_MODE === 'real' ? Real : Mock`——任何非 'real' 的取值
 *      （未配置、拼错、大写 REAL）都会静默换成会伪造 openid 与手机号的 Mock。
 *
 * 共同点：配置不对时不报错，而是换一个「看起来在工作」的假实现。这种失效没有
 * 任何外部症状，只能靠对比数据指纹才能发现。
 *
 * 规则：模块里选择实现时，必须在配置无法识别时抛错，不允许用三元/`||`/`??`
 * 静默兜底到 Mock。
 */

const SRC = __dirname;

function moduleFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) moduleFiles(p, out);
    else if (e.name.endsWith('.module.ts')) out.push(p);
  }
  return out;
}

/** 去掉注释，避免把说明文字里的示例当成代码 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const MOCK_NAME = /\b(Mock|Stub|Fake|Noop)[A-Za-z]*\b/;

describe('不得静默退回 Mock 实现', () => {
  const files = moduleFiles(SRC);

  it('存在待检查的模块文件', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('模块里不得用三元表达式在 Mock 与真实实现之间选择', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      // 形如 `cond ? RealX : MockX` 或 `cond ? MockX : RealX`
      for (const m of src.matchAll(/\?[^?:;\n]*:[^;\n]*/g)) {
        if (MOCK_NAME.test(m[0])) offenders.push(`${path.relative(SRC, file)} → ${m[0].trim().slice(0, 80)}`);
      }
      // 形如 `useClass: someCond || MockX` / `?? MockX`
      for (const m of src.matchAll(/(?:\|\||\?\?)\s*(?:new\s+)?(Mock|Stub|Fake|Noop)[A-Za-z]*/g)) {
        offenders.push(`${path.relative(SRC, file)} → ${m[0].trim()}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下模块在配置不明确时会静默换成 Mock 实现，属于「看起来在工作、实际是假的」：\n  ' +
          offenders.join('\n  ') +
          '\n请改用 useFactory，并在配置无法识别时 throw——宁可启动失败。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('每个选择 Mock 的工厂都必须在配置无法识别时抛错', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      if (!MOCK_NAME.test(src)) continue;
      // 该模块引用了 Mock 实现，就必须同时出现 throw（配置兜底）
      if (!/throw new Error/.test(src)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下模块引用了 Mock 实现但没有任何 throw，无法保证配置错误时会拒绝启动：\n  ' +
          offenders.join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('三个关键开关都要求显式取值：PAY_MODE、WX_MODE、对账单渠道', () => {
    const payment = stripComments(fs.readFileSync(path.join(SRC, 'payment/payment.module.ts'), 'utf8'));
    const wx = stripComments(fs.readFileSync(path.join(SRC, 'wx/wx.module.ts'), 'utf8'));
    const recon = stripComments(
      fs.readFileSync(path.join(SRC, 'reconciliation/reconciliation.module.ts'), 'utf8'),
    );
    expect(payment).toContain('PAY_MODE 必须明确配置');
    expect(wx).toContain('WX_MODE 必须明确配置');
    expect(recon).toContain('PAY_MODE 必须明确配置');
  });
});
