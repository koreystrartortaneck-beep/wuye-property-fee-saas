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
