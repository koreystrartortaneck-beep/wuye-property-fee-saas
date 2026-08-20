#!/usr/bin/env node
/*
 * 入库内容的红线检查 —— 原来靠我每次提交前手跑 grep，靠人记不如靠机器。
 *
 * 两道:
 *   ① 敏感**路径**:.env / deploy/secrets / *.pem / wxpay/ / 表格与导出件。
 *      这些文件要么是真密钥,要么装着业主真实姓名手机号(《2026缴费情况.xlsx》就是),
 *      一旦入库 git 历史里就永远删不干净。
 *   ② 真实**手机号**:仓库里现存的全是明显的测试号,列成允许清单;
 *      以后混进任何新号码都会红。允许清单只能在「确认这是假号」时手动加。
 *
 * 二进制文件绕得过文字扫描(xlsx 里的号码 grep 不到),所以①按扩展名兜底 ——
 * 两道合起来才闭环,少任何一道都有真实漏法。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BAD_PATH = [
  /*
   * 两种命名都要挡:`.env` / `.env.production`(点开头),以及 `prod.env` / `deploy.env`
   * (以 .env 结尾)。原来只写了前者 —— 注入验证时 deploy-probe.env 大摇大摆溜过去了。
   * .env.example 是**故意入库**的占位符模板,由下面的高熵值检查单独把关。
   */
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/i,
  /(^|\/)[^/]+\.env$/i,
  /(^|\/)deploy\/secrets\//i,
  /\.pem$/i,
  /(^|\/)wxpay\//i,
  /\.(xlsx|xls|csv)$/i,
  // outputs/ 只挡数据导出件(带业主姓名手机号的清单);
  // 早于这条规则入库的旧调研文档与设计稿不在其列
  /(^|\/)outputs\/.*\.(csv|json|xlsx)$/i,
  /物业费缴费规则/,
];

/** 已确认是假号的测试号。加之前先确认它不是真人号码。 */
const FAKE_PHONES = new Set([
  '13800138000', '13800138001', '13800138002',
  '13800000000', '13800000001', '13800000002', '13800000003',
  '13800001111', '13900001111', '13900002222', '13700003333',
  '13900000000', '13900139000', '13511110000', '13711112222', '13633334444',
]);

const files = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 << 20 })
  .toString().split('\0').filter(Boolean);

const badPaths = files.filter((f) => BAD_PATH.some((re) => re.test(f)));

const hits = [];
for (const f of files) {
  let buf;
  try { buf = readFileSync(f); } catch { continue; }
  // 二进制不扫(扫了也是噪音);它们由①按扩展名兜住
  if (buf.includes(0)) continue;
  const text = buf.toString('utf8');
  for (const m of text.matchAll(/1[3-9]\d{9}/g)) {
    if (!FAKE_PHONES.has(m[0])) hits.push(`${f}: ${m[0].slice(0, 3)}****${m[0].slice(-4)}`);
  }
}

/*
 * .env.example 是模板,但它最容易被顺手填上真值(改一版配置忘了清空)。
 * 真密钥的形状是 32+ 位的高熵串;占位符里带 dev-/your/example/xxx 的放过。
 */
const LOOKS_REAL = /[A-Za-z0-9+/=_-]{32,}/;
const leaky = [];
for (const f of files.filter((x) => /\.env\.example$/.test(x))) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)\s*=\s*"?([^"#]+)"?/.exec(line.trim());
    if (!m) continue;
    const [, key, raw] = m;
    const val = raw.trim();
    if (!LOOKS_REAL.test(val)) continue;
    if (/dev-|your|example|placeholder|xxx|localhost|127\.0\.0\.1/i.test(val)) continue;
    leaky.push(`${f}: ${key}`);
  }
}

let bad = false;
if (leaky.length) {
  bad = true;
  console.error('✗ 占位符模板里出现了真密钥形状的值（只报键名）：');
  for (const l of leaky) console.error('   ' + l);
}
if (badPaths.length) {
  bad = true;
  console.error('✗ 敏感文件进了 git（只报路径，不打印内容）：');
  for (const f of badPaths) console.error('   ' + f);
  console.error('  处理：git rm --cached <文件> 并加进 .gitignore。');
}
if (hits.length) {
  bad = true;
  console.error('✗ 疑似真实手机号入库（已掩码显示）：');
  for (const h of [...new Set(hits)]) console.error('   ' + h);
  console.error('  若确认是测试号，把它加进 tools/check-secrets.mjs 的 FAKE_PHONES。');
}
if (bad) process.exit(1);
console.log(`✓ 红线检查通过：${files.length} 个入库文件，无敏感路径、无非白名单手机号`);
