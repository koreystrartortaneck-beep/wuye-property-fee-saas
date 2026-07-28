const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 小程序结构守卫。
 *
 * 后台已有三类静态守卫（悬空样式类、共享类不得重复声明、跳转参数必须被读取），
 * 小程序一直没有同等检查，结果积了一批「类名写了、样式没写」的元素：
 *   - receipt 的 .rc-stamp-void 无规则，「已作废」和「收讫」渲染成一样的红章，
 *     业主看不出收据无效；
 *   - pay-confirm 的 .paused-tip/.paused-title/.paused-desc 全无规则，
 *     「为什么交不了钱」的说明文字贴着卡片边缘、标题与正文不分主次；
 *   - service-hall（第四个 tab 页）的 .hall-page 规则压根没写，底部留白比
 *     另外三个 tab 页少。
 * 这些都不会让编译失败，只能靠检查兜住。
 */

const MP = path.join(__dirname, '..', 'apps', 'miniprogram');
const PAGES = path.join(MP, 'pages');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function pageDirs() {
  return fs
    .readdirSync(PAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((d) => fs.existsSync(path.join(PAGES, d, `${d}.wxml`)))
    .sort();
}

/**
 * 已定义的类名。
 * 必须先剥掉 /* *\/ 注释：注释里为了说明问题常会写出类名（例如本文件顶部就提到
 * .rc-stamp-void），若把注释算作定义，删掉真规则后检查依然通过——这个守卫
 * 第一版就栽在这里，删掉 .rc-stamp-void 的规则后测试仍然是绿的。
 */
function definedClasses(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...stripped.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/**
 * wxml 里真正用到的类名。
 * class="a b {{ x ? 'c' : 'd' }}" → {a, b, c, d}
 * 表达式里只取字符串字面量，且要排除比较用的枚举值（如 status === 'PAID'）。
 */
function usedClasses(wxml) {
  const out = new Set();
  for (const m of wxml.matchAll(/class="([^"]*)"/g)) {
    const val = m[1];
    for (const em of val.matchAll(/\{\{(.*?)\}\}/g)) {
      const expr = em[1];
      // 去掉比较运算右侧的字面量，剩下的才是当类名用的
      const cleaned = expr.replace(/[=!]==?\s*['"][^'"]*['"]/g, '');
      for (const lit of cleaned.matchAll(/['"]([A-Za-z][\w -]*)['"]/g)) {
        for (const t of lit[1].split(/\s+/)) if (t) out.add(t);
      }
    }
    /*
     * 静态部分：把 {{...}} 换成一个哨兵字符再切词。
     * 不能直接换成空格——`class="s-{{item.status}}"` 会切出残缺的 `s-`，
     * 而真实类名是 `.s-PAID` 这类拼接结果，静态检查无从验证，只能跳过。
     */
    for (const t of val.replace(/\{\{.*?\}\}/g, '\u0000').split(/\s+/)) {
      if (t.includes('\u0000')) continue; // 与插值拼接而成的类名，跳过
      if (/^[A-Za-z][\w-]*$/.test(t)) out.add(t);
    }
  }
  return out;
}

const globalClasses = definedClasses(read(path.join(MP, 'app.wxss')));

test('app.json 声明的页面与磁盘一致（多余文件永远打不开，缺失文件启动即崩）', () => {
  const app = JSON.parse(read(path.join(MP, 'app.json')));
  const declared = new Set(app.pages);
  const onDisk = new Set(pageDirs().map((d) => `pages/${d}/${d}`));
  const missing = [...declared].filter((p) => !onDisk.has(p));
  const orphan = [...onDisk].filter((p) => !declared.has(p));
  assert.deepStrictEqual(missing, [], `app.json 声明了不存在的页面: ${missing.join(', ')}`);
  assert.deepStrictEqual(orphan, [], `页面文件存在但未在 app.json 声明，永远打不开: ${orphan.join(', ')}`);
});

test('所有跳转目标都在 app.json 里声明过', () => {
  const app = JSON.parse(read(path.join(MP, 'app.json')));
  const declared = new Set(app.pages);
  const bad = [];
  const files = [];
  for (const d of pageDirs()) files.push(path.join(PAGES, d, `${d}.js`));
  for (const f of fs.readdirSync(path.join(MP, 'utils'))) files.push(path.join(MP, 'utils', f));
  files.push(path.join(MP, 'app.js'));

  for (const f of files) {
    if (!fs.existsSync(f) || !f.endsWith('.js')) continue;
    const src = read(f);
    for (const m of src.matchAll(
      /(navigateTo|redirectTo|switchTab|reLaunch)\s*\(\s*\{[^}]*url:\s*[`'"]([^`'"?]+)/g,
    )) {
      const url = m[2].replace(/^\//, '');
      if (url && !declared.has(url)) bad.push(`${path.basename(f)} → ${m[1]}('${url}')`);
    }
  }
  assert.deepStrictEqual(bad, [], `跳转到了未声明的页面，点击会静默失败:\n  ${bad.join('\n  ')}`);
});

test('wxml 用到的样式类都有定义（否则元素完全没样式，编译不报错）', () => {
  const problems = [];
  for (const d of pageDirs()) {
    const wxml = read(path.join(PAGES, d, `${d}.wxml`));
    const wxssPath = path.join(PAGES, d, `${d}.wxss`);
    const local = fs.existsSync(wxssPath) ? definedClasses(read(wxssPath)) : new Set();
    const missing = [...usedClasses(wxml)]
      .filter((c) => !local.has(c) && !globalClasses.has(c))
      .sort();
    if (missing.length) problems.push(`${d}: ${missing.join(' ')}`);
  }
  assert.deepStrictEqual(
    problems,
    [],
    `以下 wxml 用了没有任何定义的样式类，元素会以裸默认样式渲染：\n  ${problems.join('\n  ')}`,
  );
});

test('四个 tab 页的页面外壳一致（底部留白由 app.wxss 统一给出）', () => {
  const app = JSON.parse(read(path.join(MP, 'app.json')));
  const tabs = app.tabBar.list.map((x) => x.pagePath);
  assert.ok(tabs.length >= 3, 'tabBar 至少应有 3 个页面');
  for (const p of tabs) {
    const d = p.split('/')[1];
    const wxml = read(path.join(PAGES, d, `${d}.wxml`));
    assert.match(
      wxml,
      /class="page[^"]*\bhas-navbar\b/,
      `${d} 缺少 has-navbar：tab 页要用自定义导航，且底部留白靠它统一给出`,
    );
  }
  // 底部留白必须只在 app.wxss 定义一次，页面里不得再写
  const dupes = [];
  for (const p of tabs) {
    const d = p.split('/')[1];
    const wxssPath = path.join(PAGES, d, `${d}.wxss`);
    if (fs.existsSync(wxssPath) && /padding-bottom:\s*48rpx/.test(read(wxssPath))) dupes.push(d);
  }
  assert.deepStrictEqual(
    dupes,
    [],
    `tab 页底部留白已收归 app.wxss 的 .page.has-navbar，以下页面又写了一遍会重新分化: ${dupes.join(', ')}`,
  );
});
