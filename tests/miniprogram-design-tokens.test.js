const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 颜色尺度：已收进 token 的色值不得再写成裸 hex。
 *
 * 背景：小程序端原本一个变量都没有（后台早有 tokens.css），54 种色值散落在 14 个页面，
 * 光文字色就 28 种 —— 六个近似灰全部用在同一个语义上，于是每页文字颜色都略有不同。
 *
 * 这一步只做零风险的一半：把重复出现的 19 种色值收进具名变量，**取值一个不改**，
 * 并用 var(--x, #原值) 的带回退写法。已用逐字节比对验证 8 个页面改动前后 PNG 完全一致。
 *
 * 这条守卫防的是尺度被立刻绕开：新代码里再写 #251c38 而不是 var(--text)，
 * 半年后又会退回「54 种色值」的状态，而那时归并的成本比现在高得多。
 */
const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'apps', 'miniprogram');

/** 已进入尺度的色值 → 变量名 */
const TOKENS = {
  '#251c38': '--text',
  '#55496b': '--text-2',
  '#7c7288': '--text-3',
  '#8b8199': '--text-4',
  '#a79eb5': '--text-5',
  '#9a92a3': '--text-6',
  '#c9a66b': '--gold',
  '#9b743a': '--gold-ink',
  '#b8862f': '--gold-deep',
  '#ead0a0': '--gold-pale',
  '#faf7f2': '--cream',
  '#fdfbf7': '--cream-2',
  '#fff1c8': '--note',
  '#c45656': '--danger',
  '#3f7d5d': '--success',
  '#2e1a47': '--ink-deep',
  '#3b2b57': '--plum',
  '#5a4680': '--plum-2',
  '#fff': '--white',
};

function wxssFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.wxss')) out.push(p);
    }
  };
  walk(path.join(MP, 'pages'));
  out.push(path.join(MP, 'app.wxss'));
  return out;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('app.wxss 里定义了全部 token', () => {
  const app = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  const missing = Object.entries(TOKENS)
    .filter(([hex, name]) => !new RegExp(`${name}:\\s*${hex}\\s*;`, 'i').test(app))
    .map(([hex, name]) => `${name}: ${hex}`);
  assert.deepStrictEqual(missing, [], `\n  app.wxss 缺少定义：\n  ${missing.join('\n  ')}`);
});

test('每处引用都带原值回退（基础库不支持自定义属性时也不变样）', () => {
  /*
   * var(--text) 与 var(--text, #251c38) 的差别在于：前者在不支持自定义属性的环境里
   * 会让这条声明失效（颜色回到继承值），后者仍是原来的颜色。
   * 这是「零风险」这个说法能成立的前提，不是可选的写法偏好。
   */
  const bad = [];
  for (const f of wxssFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/var\((--[\w-]+)\s*(,?)([^)]*)\)/g)) {
      if (!Object.values(TOKENS).includes(m[1])) continue;
      if (!m[2] || !m[3].trim()) bad.push(`${path.relative(MP, f)}: var(${m[1]}) 缺回退值`);
    }
  }
  assert.deepStrictEqual(bad, [], `\n  ${bad.join('\n  ')}`);
});

test('已进入尺度的色值不得再写成裸 hex', () => {
  const offenders = [];
  for (const f of wxssFiles()) {
    const rel = path.relative(MP, f);
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // token 定义行本身与注释行跳过
      if (/^\s*--[\w-]+\s*:/.test(line)) return;
      if (/^\s*\*/.test(line) || /^\s*\/\*/.test(line)) return;
      // 去掉 var(...) 里的回退值，剩下的裸 hex 才算违规
      const stripped = line.replace(/var\([^)]*\)/g, 'VAR');
      for (const m of stripped.matchAll(/#[0-9a-fA-F]{3,8}/g)) {
        const hex = m[0].toLowerCase();
        if (TOKENS[hex]) offenders.push(`${rel}:${i + 1} ${m[0]} → var(${TOKENS[hex]}, ${m[0]})`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [], `\n  ${offenders.join('\n  ')}`);
});

test('检测器自身有效（正向对照）', () => {
  // 否则上面那条在检测逻辑写坏时会永真
  const fake = '.x { color: #251c38; }';
  const stripped = fake.replace(/var\([^)]*\)/g, 'VAR');
  const hits = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}/g)].filter((m) => TOKENS[m[0].toLowerCase()]);
  assert.strictEqual(hits.length, 1, '应能认出裸 hex');
  const ok = '.x { color: var(--text, #251c38); }';
  const strippedOk = ok.replace(/var\([^)]*\)/g, 'VAR');
  assert.strictEqual([...strippedOk.matchAll(/#[0-9a-fA-F]{3,8}/g)].length, 0, 'var() 里的回退值不该算违规');
});

test('未进入尺度的零散色值有记录，且数量不再增长', () => {
  /*
   * 这 35 种各出现 ≤6 次（多为渐变端点），归并需要在真机上逐页比对，本轮没做。
   * 这里只钉一个上界：不许再往里加新的一次性颜色 ——
   * 否则「等有空再统一」会变成「越等越多」。
   */
  const seen = new Set();
  for (const f of wxssFiles()) {
    const src = fs.readFileSync(f, 'utf8').replace(/var\([^)]*\)/g, 'VAR');
    for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}/g)) {
      const hex = m[0].toLowerCase();
      if (!TOKENS[hex]) seen.add(hex);
    }
  }
  assert.ok(
    seen.size <= 35,
    `未纳入尺度的色值涨到 ${seen.size} 种（上限 35）。新增的：请改用现有 token，或与既有值一并纳入尺度。`,
  );
});

/*
 * ── flex 行里的 button 必须同时约束宽度 ──
 *
 * 业主连续指出两处：生活服务卡片的「¥5.00 元/次」被挤成两行（断在单位中间），
 * 绑定页的「搜索」按钮占掉整行 45%、输入框反倒放不下小区名。
 *
 * 同一个根因：**小程序 button 的基准宽度远大于它的文字内容**。
 * 只写 flex-shrink: 0（作者显然知道它在 flex 行里）反而更糟 ——
 * 那等于把一个过宽的基准锁死，旁边的金额/输入框只能被挤到折行。
 * 必须同时写 width: auto。
 *
 * 这条规律可以静态检查：凡是给 button 类写了 flex-shrink: 0 的，
 * 就必须也写 width。
 */
test('给 button 写了 flex-shrink: 0 的，必须同时写 width', () => {
  const glob = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? glob(p) : p.endsWith('.wxss') ? [p] : [];
    });

  const offenders = [];
  for (const wxssPath of glob(path.join(MP, 'pages'))) {
    const page = path.basename(path.dirname(wxssPath));
    const wxmlPath = path.join(path.dirname(wxssPath), `${page}.wxml`);
    if (!fs.existsSync(wxmlPath)) continue;
    const wxml = fs.readFileSync(wxmlPath, 'utf8');
    const wxss = fs.readFileSync(wxssPath, 'utf8');

    // 只看真的用在 <button> 上的类
    const btnClasses = new Set();
    for (const m of wxml.matchAll(/<button[^>]*class="([^"]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c && !c.includes('{{')) btnClasses.add(c);
    }
    for (const c of btnClasses) {
      const re = new RegExp(`^\\.${c.replace(/[-]/g, '\\-')}\\s*\\{([^}]*)\\}`, 'm');
      const m = re.exec(wxss);
      if (!m) continue;
      /*
       * 必须先剥掉注释再判。
       * 我给这些规则写的注释里就有「必须同时写 width: auto」这句话 ——
       * 不剥的话，把真正的声明删掉之后，断言仍然在注释上命中、守卫形同虚设。
       * 实测：注入「删掉 bill-pay-btn 的 width」时守卫没红，就是这个原因。
       * 今天第五次栽在「注释里有同一句话」上，这次把它写进检查器本身。
       */
      const rule = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
      if (!/flex-shrink:\s*0/.test(rule)) continue;
      if (/width\s*:/.test(rule)) continue;
      offenders.push(`${page} .${c}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `这些 button 写了 flex-shrink: 0 却没写 width，会挤压同行的金额/输入框：\n  ${offenders.join('\n  ')}`,
  );
});

test('价格不许折行——金额被断在单位中间是最不该出的错', () => {
  const wxss = fs.readFileSync(path.join(MP, 'pages/services/services.wxss'), 'utf8');
  const i = wxss.indexOf('.svc-price');
  assert.ok(i > 0);
  const rule = wxss.slice(i, wxss.indexOf('}', i)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(rule, /white-space:\s*nowrap/, '服务价格可能折行');
  assert.match(rule, /flex-shrink:\s*0/, '服务价格会被按钮挤压');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✕ ${name}\n    ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
