const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADMIN = path.join(ROOT, 'apps', 'admin', 'src');
const MINI = path.join(ROOT, 'apps', 'miniprogram');

/**
 * 同一个概念在三端只能有一个叫法。
 *
 * 实测的漂移（统计口径：非注释的面向用户文案）：
 *   房屋 90 处 / 房产 8 处   —— 房产偏产权与资产语义，而业主绑定的是「我住的那间」，
 *                              后端字段、错误码、小程序 40 余处文案都用「房屋」
 *   业主 108 处 / 住户 12 处 —— 住户只存在于后台，业主端 0 处。物业接电话时业主会说
 *                              「我是业主」，后台却分「住户」页与「业主」列，员工要
 *                              做一次心译。而 nav.ts 同一行里就写着「住户档案」而
 *                              分段标签是「房屋与业主」，自相矛盾
 *   物业公示 9 处（业主端）  —— 后台却有「巡检留痕」「工作日志」「工作照片墙」三个
 *                              名字，没有一个是「物业公示」。业主打电话问「物业公示
 *                              里那条绿化」，员工在后台搜不到这个词
 *
 * 另有 23 条 router.ts 的 meta.title 是死文案（Layout 用 nav.ts 的 locate()，
 * 没有任何地方读 meta.title 或给 document.title 赋值），却保存着一整套与实际显示
 * 系统性冲突的旧词汇——照着它改文案会改错地方。已整体删除，本文件盯着它别回来。
 */

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** 只看代码与模板，剥掉注释（注释里为说明问题会写出被禁的词） */
function code(p) {
  return fs
    .readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** 概念 → { 采用, 禁用[], 理由 } */
const TERMS = [
  { use: '房屋', ban: ['房产'], why: '房产偏产权/资产语义；后端字段、错误码与业主端 40 余处都用「房屋」' },
  { use: '业主', ban: ['住户'], why: '住户只存在于后台，业主端 0 处；业主自称「业主」' },
  { use: '已使用', ban: ['已核销'], why: '核销是财务/门岗术语' },
  { use: '已作废', ban: ['红冲'], why: '红冲是会计术语，而该状态在业主退款后由系统自动置上，业主必然看到' },
];

test('后台不得出现被弃用的术语', () => {
  const offenders = [];
  for (const f of walk(ADMIN, ['.vue', '.ts'])) {
    if (f.endsWith('.spec.ts')) continue;
    const src = code(f);
    for (const t of TERMS) {
      for (const bad of t.ban) {
        if (src.includes(bad)) {
          offenders.push(`${path.relative(ADMIN, f)} 出现「${bad}」，应统一为「${t.use}」（${t.why}）`);
        }
      }
    }
  }
  assert.deepStrictEqual(offenders, [], '\n  ' + offenders.join('\n  '));
});

test('业主端不得出现被弃用的术语', () => {
  const offenders = [];
  for (const f of walk(MINI, ['.js', '.wxml'])) {
    const src = code(f);
    for (const t of TERMS) {
      for (const bad of t.ban) {
        if (src.includes(bad)) {
          offenders.push(`${path.relative(MINI, f)} 出现「${bad}」，应统一为「${t.use}」`);
        }
      }
    }
  }
  assert.deepStrictEqual(offenders, [], '\n  ' + offenders.join('\n  '));
});

test('router.ts 不得再有死的 meta.title', () => {
  /*
   * 它不显示，却是一整套与实际显示冲突的旧词汇。页面标题的唯一来源是 nav.ts。
   * 如果将来真要设 document.title，应该从 nav.ts 的 locate() 取，而不是复活这份。
   */
  const src = code(path.join(ADMIN, 'router.ts'));
  assert.ok(
    !/meta:\s*\{[^}]*title:/.test(src),
    'router.ts 又出现了 meta.title —— 它不会显示，只会成为下一轮术语漂移的来源',
  );
});

test('导航分组名与其子项用词不矛盾', () => {
  /*
   * 原状：分组叫「住户」，子项叫「房屋与业主」，同一行的 hint 又写「查住户档案」。
   * 这里只做一件事：分组名里的核心名词必须在被弃用清单之外。
   */
  const src = code(path.join(ADMIN, 'nav.ts'));
  const groups = [...src.matchAll(/label:\s*'([^']+)',\s*\n\s*icon:/g)].map((m) => m[1]);
  assert.ok(groups.length >= 4, `只解析到 ${groups.length} 个分组，正则可能失效`);
  const bad = groups.filter((g) => TERMS.some((t) => t.ban.some((b) => g.includes(b))));
  assert.deepStrictEqual(bad, [], `导航分组名用了被弃用的词：${bad.join('、')}`);
});

test('业主端一律用敬语「您」', () => {
  /*
   * 小程序 9 个文件用「您」、13 处；而 mine.js 一个文件用「你」、8 处——
   * 而 mine.js 恰好是注销、隐私、订阅设置这些高敏场景，敬语更稳。
   * 后端 payment.service 也有一处「优惠券不存在或不属于你」会原样 toast 给业主。
   *
   * 只查业主可见文案：管理端对内说「你」是可以的（Operations 里就有「推送给你」）。
   */
  const offenders = [];
  for (const f of walk(MINI, ['.js', '.wxml'])) {
    const src = code(f);
    // 「你」作为第二人称代词；排除「其他」这类不含代词义的组合
    for (const m of src.matchAll(/.{0,12}你.{0,12}/g)) {
      offenders.push(`${path.relative(MINI, f)}：…${m[0].trim()}…`);
    }
  }
  assert.deepStrictEqual(offenders, [], '\n  ' + offenders.join('\n  '));
});

test('后端给业主看的提示也用「您」', () => {
  /*
   * 业主端 utils/request.js 把后端 message 原样 toast，所以业主可达路径上的
   * BizException 文案是逐字上屏的。
   */
  const API = path.join(ROOT, 'apps', 'api', 'src');
  const offenders = [];
  for (const f of walk(API, ['.ts'])) {
    if (f.endsWith('.spec.ts')) continue;
    const src = code(f);
    for (const m of src.matchAll(/'[^']*不属于你[^']*'|'[^']*你的[^']*'/g)) {
      offenders.push(`${path.relative(API, f)}：${m[0]}`);
    }
  }
  assert.deepStrictEqual(offenders, [], '\n  ' + offenders.join('\n  '));
});
