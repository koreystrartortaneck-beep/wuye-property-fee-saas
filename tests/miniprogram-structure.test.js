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
  // 分包页面(root/pages/...)与主包页面同等有效——漏了它们守卫就会误报新入口
  const declared = new Set([
    ...app.pages,
    ...(app.subpackages || []).flatMap((s) => s.pages.map((p) => `${s.root}/${p}`)),
  ]);
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

/*
 * ──「我的」只放跟我有关的 ──
 *
 * 业主指出：社区公告、物业公示是全小区内容，摆在「我的」里是累赘。
 * 它们由首页「社区动态 → 查看全部」进 community 页（自带 全部/公告/物业公示 筛选），
 * 独立的 announcements / work-wall 页面与之完全重复，已删除。
 */

test('「我的」菜单每一项都是个人相关，且路由真实存在', () => {
  const js = fs.readFileSync(path.join(MP, 'pages/mine/mine.js'), 'utf8');
  // 菜单 key 白名单：新增一项前先问「这是"我的"吗」
  const PERSONAL = new Set(['tickets', 'orders', 'payments', 'coupons', 'notify']);
  const keys = [...js.matchAll(/\{ key: '(\w+)', title:/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4, `菜单解析失败，只找到 ${keys.length} 项`);
  const alien = keys.filter((k) => !PERSONAL.has(k));
  assert.deepStrictEqual(alien, [], `「我的」里混入了非个人内容：${alien.join('、')}`);
  // 每个 key 都要有对应的跳转/处理，否则是死菜单
  for (const k of keys) {
    if (k === 'notify') continue; // notify 走 enableNotify
    assert.ok(js.includes(`key === '${k}'`), `菜单项 ${k} 没有对应的跳转处理`);
  }
});

test('WXML 表达式里不许有函数调用——不报错,只是永远求不出值', () => {
  /*
   * 2026-08-03 实测(用户截图):催缴页勾选一个勾都不亮,而按钮上的「已选 1 户」
   * 是对的。原因是 WXML 里写了 `picked.indexOf(item.houseId) >= 0` ——
   * **WXML 的数据绑定不支持函数调用**,这段求值为空,判断恒假。
   * 编译不报错、运行不告警,界面就是点了没反应。
   *
   * 更坏的是同一个写法早就躺在批量出账页里:那里判断反着写
   * (`indexOf(...) >= 0 ? '' : 'tick-on'`),求不出值反而恒真 ——
   * 于是每一行都显示「会出账」,剔除看上去从来没生效。
   * 用户两次反馈的「勾选有问题」都是这一个原因。
   *
   * 状态一律在 JS 里算成每行一个布尔值再交给 WXML。
   * 这一条扫全部 wxml(业主端也一样受这个限制)。
   */
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.wxml')) {
        const src = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        for (const m of src.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
          // 属性访问 (a.b) 允许;带括号的调用 (a.b(...)) 不允许
          const call = /\.[a-zA-Z_$][\w$]*\s*\(/.exec(m[1]);
          if (call) offenders.push(`${path.relative(MP, p)} → {{${m[1].trim().slice(0, 60)}}}`);
        }
      }
    }
  };
  walk(MP);
  assert.deepStrictEqual(offenders, [], `WXML 不支持函数调用,这些绑定永远求不出值:\n  ${offenders.join('\n  ')}`);
});

test('社区内容仍然可达：首页「查看全部」→ community，且带公告/公示筛选', () => {
  /*
   * 删掉重复页面的前提是 community 页真的覆盖它们。
   * 这条断言防「有人把 community 的筛选删了」——那时公示墙就真的无处可看了。
   */
  const idx = fs.readFileSync(path.join(MP, 'pages/index/index.js'), 'utf8');
  assert.match(idx, /pages\/community\/community/, '首页不再通向社区动态页');
  const comm = fs.readFileSync(path.join(MP, 'pages/community/community.js'), 'utf8');
  assert.ok(comm.includes("value: 'ann'") && comm.includes("value: 'work'"), 'community 页丢了公告/公示筛选');
});

test('删掉的冗余页面不再被任何地方引用', () => {
  /*
   * 跳过点文件:miniprogram-hang-and-scope 会在 utils/ 下临时落一个探针
   * (utils/.upload-timeout-probe.js)再删掉,而 node --test 是并行跑文件的 ——
   * 走到它时文件可能已经消失,readFileSync 抛 ENOENT,这一条就随机变红。
   * build-stamp 与 terminology 两个用例早就各自躲过它了,这里补齐。
   */
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const offenders = [];
  for (const f of walk(path.join(MP, 'pages')).concat(walk(path.join(MP, 'utils')))) {
    if (!/\.(js|wxml|json)$/.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/pages\/(announcements\/announcements|work-wall\/work-wall)/.test(src)) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, [], `仍有引用已删除页面的文件`);
});
