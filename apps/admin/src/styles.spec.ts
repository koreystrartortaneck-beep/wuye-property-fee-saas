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

function classesIn(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/** ui.css 顶层声明的共享类（不含伪类/组合选择器里的次要部分） */
function sharedClasses(): Set<string> {
  const css = read('styles/ui.css');
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
      // 只看「行首即选择器」的规则，允许 .cell-sub.overdue 这类在共享类上追加修饰
      for (const m of sty[1].matchAll(/(?:^|\n)\s*\.([a-zA-Z][\w-]*)\s*\{/g)) {
        if (shared.has(m[1])) offenders.push(`${path.relative(SRC, file)} → .${m[1]}`);
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
