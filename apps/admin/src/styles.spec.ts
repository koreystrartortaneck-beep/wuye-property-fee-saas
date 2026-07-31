import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守护后台的视觉一致性。
 *
 * 起因：改版前 27 个页面各自维护 <style scoped>，合计 1570 行，其中 .toolbar
 * 被写了 19 遍并分化出 9 种不同写法（6 处甚至漏了 display:flex），.pager 14 遍、
 * 空状态 12 遍。同一个控件在不同页面疏密与对齐都不同，这就是「整体性差」的来源。
 * 收敛到 styles/ui.css 之后，必须有测试挡住它再次分化。
 *
 * 两条规则：
 *   1) 页面不得重新声明 ui.css 已定义的共享类（scoped 优先级更高，会盖回旧样式）；
 *   2) 模板用到的类必须有定义，否则排版静默塌掉（构建与类型检查都发现不了）。
 */

const SRC = __dirname;

function read(p: string) {
  return fs.readFileSync(path.join(SRC, p), 'utf8');
}

/**
 * CSS 里已定义的类名。
 * 必须先剥掉注释：注释里为了说明来龙去脉常会写出类名（ui.css 的顶部注释就提到
 * .toolbar/.pager），把注释算作定义会让「悬空类名」检查出现假阴性——删掉真规则
 * 后测试依然是绿的。小程序那份同类守卫第一版正是栽在这里。
 */
function classesIn(css: string): Set<string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...stripped.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/** ui.css 顶层声明的共享类（不含伪类/组合选择器里的次要部分） */
function sharedClasses(): Set<string> {
  // 同样先剥注释：ui.css 顶部注释里提到 .toolbar/.pager，算进来会让共享类集合虚高
  const css = read('styles/ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  // 只取选择器位置在行首的类名，避免把 .stat-value.is-good 里的 is-good 也算共享
  for (const m of css.matchAll(/(?:^|\n)\s*\.([a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) vueFiles(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

/**
 * 模板里的静态类名。
 * 必须排除 :class / v-bind:class —— 那里面是 JS 表达式而不是类名，
 * 早先的检查脚本因为 `class="` 也能匹配到 `:class="` 而把表达式片段当成类名。
 */
function staticClasses(tpl: string): Set<string> {
  const used = new Set<string>();
  for (const m of tpl.matchAll(/(^|[\s"'>])class="([^"]*)"/g)) {
    for (const tok of m[2].split(/\s+/)) {
      if (tok && !tok.includes('{') && !tok.includes('}')) used.add(tok);
    }
  }
  for (const m of tpl.matchAll(/:class="([^"]*)"/g)) {
    for (const q of m[1].matchAll(/'([a-zA-Z][\w-]*)'/g)) used.add(q[1]);
    for (const k of m[1].matchAll(/([a-zA-Z][\w-]*)\s*:/g)) used.add(k[1]);
  }
  return used;
}

const globalClasses = new Set([...classesIn(read('styles/tokens.css')), ...classesIn(read('styles/ui.css'))]);
const shared = sharedClasses();
const files = vueFiles(SRC);

describe('后台视觉一致性', () => {
  it('存在待检查的组件', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(shared.size).toBeGreaterThan(15);
  });

  it('ui.css 是全局样式，不能出现 :deep()（那是 SFC scoped 专用语法，写在这里整条规则会失效）', () => {
    // 先去掉注释：说明文字里提到这个语法是合理的，只有真出现在选择器里才是错
    const css = read('styles/ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toContain(':deep(');
  });

  it('页面不得重新声明 ui.css 的共享类', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sty = fs.readFileSync(file, 'utf8').match(/<style[^>]*>([\s\S]*?)<\/style>/);
      if (!sty) continue;
      /*
       * 判据：规则的**作用对象**是否就是共享类本身。
       *
       * 取选择器最后一个后代分段（真正被这条规则修饰的那个元素），看它的类名集合：
       * 若其中每一个类都是共享类，则这条规则在重新定义共享结构 → 违规；
       * 若含至少一个非共享类，那是在共享类上追加本页修饰态 → 允许。
       *
       * 原实现用行首锚点 /(?:^|\n)\s*\.(cls)\s*\{/，只认「.foo {」一种形式，
       * 而特异性更高（覆盖更彻底）的四种自然写法全部绕过——实测在 Payments.vue 里
       * 注入 .toolbar{display:block} 的等价变体：
       *   .toolbar {          → 抓到
       *   div.toolbar {       → 漏
       *   .el-card .toolbar { → 漏  ← 「只想微调本页卡片里的 toolbar」最自然的写法
       *   * .toolbar {        → 漏
       *   .toolbar, .zzz {    → 漏  ← 普通分组选择器
       * 也就是说守卫只挡住了最不可能被写出来的那一种。
       *
       * 反过来，第一版加宽后又误伤了 .cell-sub.overdue、.empty p、
       * :deep(.el-table__row) 这三类合法写法——它们的作用对象都不是共享类。
       * 「作用对象」这个判据两头都对。
       */
      const css = sty[1].replace(/\/\*[\s\S]*?\*\//g, '');
      for (const rule of css.split('}')) {
        const brace = rule.indexOf('{');
        if (brace === -1) continue;
        const selector = rule.slice(0, brace);
        if (selector.includes('@')) continue; // @media/@supports 的块头不是选择器
        for (const part of selector.split(',')) {
          // 最后一个后代分段即规则的作用对象（伪类/伪元素不改变作用对象，先剥掉）
          const subject = part.trim().split(/[\s>+~]+/).pop() ?? '';
          const classes = [...subject.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
          if (classes.length === 0) continue;
          if (classes.every((c) => shared.has(c))) {
            offenders.push(`${path.relative(SRC, file)} → ${part.trim()}`);
          }
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下页面重新声明了 styles/ui.css 的共享类，scoped 优先级更高会盖回旧样式，' +
          '各页面外观会再次分化：\n  ' +
          [...new Set(offenders)].join('\n  ') +
          '\n共享结构请直接用 ui.css 的类；确有本页特有差异时另起一个页面专属类名。',
      );
    }
    expect(offenders).toEqual([]);
  });

  /*
   * 表格必须有空状态，且一个表格只能有一个。
   *
   * 这两条各抓出一个改版前就存在的 bug：
   *   FeeRules 的「还没有收费标准」被放进了带 v-if="formulaRules.length > 0" 的
   *   卡片里，表格为空时整卡不渲染，那个空状态永远不可能显示，而真正的规则表格
   *   反倒没有空状态；MeterReadings 的「还没有抄表记录」挂在「未录房屋」表上，
   *   等于全部录完时才提示「还没有记录」。
   *
   * 重复 #empty 会让 vite 构建直接失败（Duplicate slot names），但 vue-tsc 不报，
   * 所以这里也兜一层，报错信息更直白。
   */
  const NO_EMPTY_OK: Record<string, string> = {
    'views/Dashboard.vue:rowsData': '仅在 rowsData.length > 1 时渲染，不可能为空',
    'views/FeeRules.vue:formulaRules': '外层卡片 v-if="formulaRules.length > 0"，为空时整卡不渲染',
  };

  it('每个表格都有空状态，且不重复', () => {
    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SRC, file);
      for (const m of src.matchAll(/<el-table\b[^>]*?:data="([^"]*)"/g)) {
        const close = src.indexOf('</el-table>', m.index! + m[0].length);
        if (close === -1) continue;
        const seg = src.slice(m.index! + m[0].length, close);
        if (seg.includes('<el-table')) continue; // 嵌套表格，跳过
        const count = (seg.match(/#empty/g) ?? []).length;
        const key = `${rel}:${m[1]}`;
        if (count === 0 && !(key in NO_EMPTY_OK)) missing.push(key);
        if (count > 1) duplicated.push(`${key}（${count} 个）`);
      }
    }
    if (duplicated.length) {
      throw new Error('一个表格里出现多个 #empty，vite 构建会报 Duplicate slot names：\n  ' + duplicated.join('\n  '));
    }
    if (missing.length) {
      throw new Error(
        '以下表格没有空状态，数据为空时是一块白板，用户不知道为什么空、也不知道下一步做什么：\n  ' +
          missing.join('\n  ') +
          '\n请加 <template #empty><EmptyState … /></template>；若外层 v-if 已保证非空，' +
          '把它连同理由加进 NO_EMPTY_OK。',
      );
    }
    expect({ missing, duplicated }).toEqual({ missing: [], duplicated: [] });
  });

  it('模板用到的样式类都有定义', () => {
    const problems: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const tpl = src.match(/<template>([\s\S]*)<\/template>/);
      if (!tpl) continue;
      const sty = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      const local = sty ? classesIn(sty[1]) : new Set<string>();
      const missing = [...staticClasses(tpl[1])]
        .filter((c) => !c.startsWith('el-') && !c.startsWith('is-'))
        .filter((c) => !local.has(c) && !globalClasses.has(c))
        .sort();
      if (missing.length) problems.push(`${path.relative(SRC, file)}: ${missing.join(' ')}`);
    }
    if (problems.length) {
      throw new Error('以下模板用了没有任何定义的样式类，排版会静默塌掉：\n  ' + problems.join('\n  '));
    }
    expect(problems).toEqual([]);
  });
});

/**
 * 语义色的文字必须可读，且映射表的 key 必须与后端真实取值一致。
 *
 * 两条都是本次审计发现的、此前所有守卫都放过的问题：
 *
 * 1) Element Plus 的浅色标签把文字色直接取语义主色，而 tokens 把
 *    --el-color-success 等映射到原始饱和色，实测对比度只有 2.04–3.26:1
 *    （AA 要 4.5:1）。本文件早就定义了可读的 -text 变体、页面 scoped CSS 里
 *    17 处也用对了，唯独 EP 这条变量链漏了——波及 38 个状态标签、27 个页面。
 *
 * 2) NOTIFY_CHANNEL_LABEL 的 key 写的是 SUBSCRIBE/SMS/NONE，而后端只写入
 *    WX_SUBSCRIBE 与 MOCK。三个 key 一个都对不上，`|| row.channel` 每行兜底，
 *    通道列一直显示英文。上一轮「修好了渲染侧」但没对齐 key，等于没修——
 *    这正是需要机器来查的一类错。
 */
describe('语义色与枚举映射', () => {
  const tokens = read('styles/tokens.css');

  it('标签的语义色文字用可读的 -text 变体，不用原始饱和色', () => {
    for (const [variant, token] of [
      ['success', '--success-text'],
      ['warning', '--warning-text'],
      ['danger', '--danger-text'],
    ] as const) {
      const re = new RegExp(`\\.el-tag--${variant}[^{]*\\{[^}]*--el-tag-text-color:\\s*var\\(${token}\\)`);
      expect(tokens).toMatch(re);
    }
    // info 也必须映射到本色阶内的灰，不能留 EP 默认的 #909399
    expect(tokens).toMatch(/--el-color-info:\s*var\(/);
  });

  it('实心 success/warning 按钮的底色用 -text 变体（白字才够对比度）', () => {
    expect(tokens).toMatch(/\.el-button--success[^}]*--el-button-bg-color:\s*var\(--success-text\)/);
    expect(tokens).toMatch(/\.el-button--warning[^}]*--el-button-bg-color:\s*var\(--warning-text\)/);
  });

  it('通知通道映射的 key 与后端写入值一致', () => {
    const finance = read('finance.ts');
    const block = finance.slice(finance.indexOf('NOTIFY_CHANNEL_LABEL'));
    const map = block.slice(0, block.indexOf('};'));
    // 后端 notify.service 只写这两个值（schema 注释亦为 WX_SUBSCRIBE | MOCK）
    expect(map).toContain('WX_SUBSCRIBE');
    expect(map).toContain('MOCK');
    /*
     * 这三个 key 从未出现过，留着只会让人以为已覆盖。
     * 必须用词边界匹配：'SUBSCRIBE:' 是 'WX_SUBSCRIBE:' 的子串，
     * 用 toContain 会把正确的 key 误判为残留（本测试第一版就是这么错的）。
     */
    for (const stale of ['SUBSCRIBE', 'SMS', 'NONE']) {
      expect(map).not.toMatch(new RegExp(`(?:^|[^_\\w])${stale}\\s*:`, 'm'));
    }
  });

  it('HouseCell 里的 .cell-main 不得盖掉链接色', () => {
    const ui = read('styles/ui.css');
    expect(ui).toMatch(/\.house-link \.cell-main[^}]*color:\s*inherit/);
    // 禁用态必须与正常态可区分
    expect(ui).toMatch(/\.house-link:disabled[^}]*color:\s*var\(--text-secondary\)/);
  });
});

/**
 * 卡片级容器必须用卡片令牌。
 *
 * 判据取自 .el-card 自身的定义（ui.css）：`--r-lg` 圆角 + `--shadow-card` 阴影。
 * 有 8 处页面手写的面板用了 `--r-md`(10px) + `--shadow-sm`，与同屏的 el-card
 * 差 4px 圆角和一档阴影——两者常常上下相邻（欠费页的概览条压在表格卡上方、
 * 住户档案的 hero 压在标签卡上方、出账页的三个步骤卡与状态条），差异肉眼可见，
 * 这正是「整体性差」的一种。
 *
 * 判据是「同时有 background: var(--bg-card) 与 box-shadow」= 它就是一张卡片，
 * 而不是「凡出现 --r-md 都算错」——.hollow（虚线空占位）与 .picked-bill
 * （行内已选账单小块）用 --r-md 是对的，它们不是卡片、也没有阴影。
 */
describe('卡片令牌一致', () => {
  it('.el-card 的规范值就是 --r-lg + --shadow-card（前提校验）', () => {
    const ui = read('styles/ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = ui.match(/\.el-card\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('border-radius: var(--r-lg)');
    expect(m![1]).toContain('box-shadow: var(--shadow-card)');
  });

  /*
   * 例外：白底 + 微阴影，但不是内容卡片的元素。
   *
   * 侧栏导航项与分段控件的选中态是「胶囊从灰色轨道上浮起」，用的就是白底加一层
   * 很浅的阴影；换成卡片级的 --shadow-card 会让一个 32px 高的胶囊拖着内容卡那么大
   * 一片投影，反而破坏层级。判据（bg-card + 阴影）对内容容器成立，对这类小控件
   * 不成立，所以显式列出而不是放宽判据——放宽会把真正该管的面板一起漏掉。
   */
  const NOT_A_CARD: Record<string, string> = {
    'layout/Layout.vue → .nav-item.on': '侧栏导航选中态胶囊，白底微阴影是刻意的',
    'layout/Layout.vue → .seg.on': '分段控件选中态胶囊，同上',
  };

  it('带 bg-card 底和阴影的手写面板，圆角与阴影跟卡片一致', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const sty = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      if (!sty) continue;
      const css = sty[1].replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/(\n\s*\.[a-zA-Z][\w-]*(?:[.:][\w-]+)?\s*)\{([^}]*)\}/g)) {
        const sel = m[1].trim();
        const body = m[2];
        if (!body.includes('var(--bg-card)') || !body.includes('box-shadow')) continue;
        if (body.includes('box-shadow: none')) continue;
        const rel = path.relative(SRC, file);
        if (`${rel} → ${sel}` in NOT_A_CARD) continue;
        if (/border-radius:\s*var\(--r-(?:xs|sm|md)\)/.test(body)) {
          offenders.push(`${rel} → ${sel} 的圆角不是 --r-lg`);
        }
        if (/box-shadow:[^;]*var\(--shadow-(?:xs|sm)\)/.test(body)) {
          offenders.push(`${rel} → ${sel} 的阴影不是 --shadow-card`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下手写面板本质上是卡片（有 bg-card 底和阴影），但圆角/阴影与 el-card 不一致，' +
          '同屏相邻时能直接看出差异：\n  ' +
          offenders.join('\n  ') +
          '\n请改用 --r-lg 与 --shadow-card；若它其实不是卡片，就去掉 bg-card 或阴影。',
      );
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * ui.css 里不得留下零使用的类。
 *
 * 死的共享 CSS 正是「各页手写孪生」的成因：`.card-grid` / `.card-grid-wide` 定义好
 * 却没人用，于是 Dashboard 自己写了 220px auto-fill 的待办网格、Operations 自己写了
 * 一份**值完全相同**的指标网格、Dashboard 又写了 320px auto-fit 的宽卡网格 ——
 * 同类卡片在不同页面换行宽度不一样，而共享类就摆在那里没人碰。
 *
 * 32 个共享类里有 7 个零使用（另 4 个是 Element Plus 的类，本来就不在模板里手写）。
 * 处理方式：能消除真实分化的就接上（两处 220px 网格 → 一个类），
 * 确实没人需要的就删掉（.card-head-extra / .toolbar-field / .card-interactive /
 * .card-stack），不留「以后也许有用」的死代码。
 */
describe('共享样式无死代码', () => {
  /** Element Plus 的类由全局样式接管，模板里本来就不会手写 */
  const EP_OVERRIDES = /^el-/;

  it('ui.css 的每个共享类都至少被一个模板用到', () => {
    const templateClasses = new Set<string>();
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const tpl = src.match(/<template>([\s\S]*)<\/template>/);
      if (!tpl) continue;
      for (const c of staticClasses(tpl[1])) templateClasses.add(c);
    }
    const dead = [...shared]
      .filter((c) => !EP_OVERRIDES.test(c))
      .filter((c) => !templateClasses.has(c))
      .sort();
    if (dead.length) {
      throw new Error(
        'styles/ui.css 里以下类没有任何模板使用。死的共享 CSS 会让人以为「没有现成的」' +
          '而各页另写一份，同一种结构就此分化：\n  .' +
          dead.join('\n  .') +
          '\n请接上（若某页手写了等价物）或删掉（若确实没人需要）。',
      );
    }
    expect(dead).toEqual([]);
  });

  it('页面不得手写与共享网格等价的 grid（断点会各自漂移）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const sty = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      if (!sty) continue;
      const css = sty[1].replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/grid-template-columns:\s*repeat\(\s*auto-(?:fit|fill)\s*,\s*minmax\(/g)) {
        offenders.push(`${path.relative(SRC, file)}（第 ${css.slice(0, m.index).split('\n').length} 行附近）`);
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下页面手写了自适应卡片网格。ui.css 已提供 .card-grid（220px 平铺）与 ' +
          '.card-grid-wide（320px 宽卡），各写一份会让同类卡片在不同页面的换行宽度不一样：\n  ' +
          offenders.join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('字重一律走令牌，不写裸数字', () => {
    /*
     * Dashboard 的 .lk-title 写的是 font-weight: 600，而全站其余都用
     * var(--fw-semibold)。数值恰好相同，所以看不出问题——但令牌一改它就掉队。
     */
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const sty = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      if (!sty) continue;
      const css = sty[1].replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/font-weight:\s*(\d{3})\b/g)) {
        offenders.push(`${path.relative(SRC, file)} → font-weight: ${m[1]}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        '字重要用 var(--fw-*) 令牌，裸数字在令牌调整后会掉队：\n  ' + offenders.join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });

  it('导出表头与屏幕列头用同一种括号', () => {
    /*
     * 屏幕上是「欠费金额（元）」，导出的 CSV 里是「欠费金额(元)」——
     * 同一列两种写法。收费员把 CSV 发给领导时，表头与系统截图对不上。
     * 全站全角括号 117 处、半角包中文 6 处，全在导出表头里。
     */
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/header: '([^']*[（(][^']*)'/g)) {
        if (/\([^)]*[一-龥][^)]*\)|[一-龥]\(/.test(m[1])) {
          offenders.push(`${path.relative(SRC, file)} → ${m[1]}`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '导出表头用了半角括号，而屏幕列头是全角，同一列两种写法：\n  ' +
          offenders.join('\n  ') +
          '\n中文语境统一用全角（）。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('flex 容器的子项不得用 float（浏览器直接忽略）', () => {
    /*
     * .el-card__header 是 flex 容器（ui.css 里就是这么定义的），而 Dashboard 的
     * .hd-period 与 Operations 的 .hd-tag 都写了 float: right —— flex 子项上的 float
     * 会被完全忽略，这两行一直是空操作，元素其实是靠 flex 默认排列落在那个位置的。
     * 看起来「生效了」，所以没人发现；但一旦 header 的 flex 布局改动，这两处就会跟着漂。
     */
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const sty = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      if (!sty) continue;
      const css = sty[1].replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/\n\.([\w-]+)[^{]*\{[^}]*float:\s*(left|right)/g)) {
        offenders.push(`${path.relative(SRC, file)} → .${m[1]} 用了 float: ${m[2]}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下类用了 float。后台的卡头、工具条、单元格都是 flex 容器，float 在 flex 子项上' +
          '会被忽略，写了等于没写：\n  ' +
          offenders.join('\n  ') +
          '\n靠右请用 margin-left: auto。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('表单标签列宽走统一令牌，不各页硬编码 px', () => {
    /*
     * 原先 15 个表单用了 7 种值（60/70/80/90/96/100/110px）——相邻页面的弹窗打开时
     * 输入框起始位置不一样，来回切换能明显看出错位。100px 取自全站最长标签
     * 「目标计费方式」（6 字约需 96px）并留余量，定义在 tokens.css 的 --form-label-w。
     */
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/label-width="(\d+)px"/g)) {
        offenders.push(`${path.relative(SRC, file)} → label-width="${m[1]}px"`);
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下表单硬编码了标签列宽，相邻页面的弹窗会错位：\n  ' +
          offenders.join('\n  ') +
          '\n请改用 label-width="var(--form-label-w)"。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('--form-label-w 已定义且足以容纳全站最长标签', () => {
    const tokens = read('styles/tokens.css');
    const m = /--form-label-w:\s*(\d+)px/.exec(tokens);
    expect(m).not.toBeNull();
    const width = Number(m![1]);

    // 全站表单里最长的中文标签
    let longest = '';
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const lm of src.matchAll(/<el-form-item label="([^"]+)"/g)) {
        if (lm[1].length > longest.length) longest = lm[1];
      }
    }
    // 中文按 14px 估，加冒号与间距约 12px
    const need = longest.length * 14 + 12;
    if (need > width) {
      throw new Error(
        `--form-label-w 是 ${width}px，但最长标签「${longest}」（${longest.length} 字）约需 ${need}px，` +
          '标签会折行或被截断。',
      );
    }
    expect(need).toBeLessThanOrEqual(width);
  });
});
