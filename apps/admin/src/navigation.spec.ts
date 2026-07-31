import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守护跳转闭环：一次 router.push 带过去的 query 参数，目标页必须真的读它。
 *
 * 起因：住户档案的「登记现金收款」按钮把 houseId 传给 /payments，而收款页的
 * 筛选只有 { communityId, channel, status }，houseId 被完全忽略——点下去页面
 * 换了但什么都没带过去，收费员又得自己去找账单 ID（而账单 ID 后台根本不显示）。
 * 这类「传了参数、对面不接」的断头路，类型检查和构建都发现不了。
 */

const SRC = __dirname;

/** 递归收集 .vue 文件（与 styles.spec.ts 同名工具，两处各自持有一份以免互相耦合） */
function vueFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) vueFiles(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

/** 去掉注释——注释里提到 clearSelection / query 参数名都会让断言失效 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}


interface Push {
  from: string;
  path: string;
  keys: string[];
}

function collectPushes(): Push[] {
  const out: Push[] = [];
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.vue')) files.push(p);
    }
  })(SRC);

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const from = path.relative(SRC, file);

    // 对象形式：router.push({ path: '/x', query: { a, b: c } })
    for (const m of src.matchAll(/router\.push\(\s*\{([\s\S]{0,500}?)\}\s*\)/g)) {
      const blob = m[1];
      const p = blob.match(/path:\s*['"]([^'"]+)/);
      const q = blob.match(/query:\s*\{([\s\S]*?)\}/);
      if (!p || !q) continue;
      // 同时支持 `a: expr` 与 ES6 简写 `a`
      const keys = q[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.split(':')[0].trim())
        .filter((k) => /^[A-Za-z_]\w*$/.test(k));
      out.push({ from, path: p[1], keys });
    }

    // 字符串形式：router.push(`/x?a=1&b=2`)
    for (const m of src.matchAll(/router\.push\(\s*[`'"](\/[^`'"?]*)\?([^`'"]*)/g)) {
      const keys = [...m[2].matchAll(/([A-Za-z_]\w*)=/g)].map((k) => k[1]);
      out.push({ from, path: m[1], keys });
    }
  }
  return out;
}

/** 路由路径 → 视图文件 */
function routeMap(): Record<string, string> {
  const src = fs.readFileSync(path.join(SRC, 'router.ts'), 'utf8');
  const map: Record<string, string> = {};
  for (const m of src.matchAll(/path:\s*'([^']*)'[\s\S]{0,200}?import\('\.\/views\/([A-Za-z]+)\.vue'\)/g)) {
    map['/' + m[1].replace(/^\//, '')] = `views/${m[2]}.vue`;
  }
  return map;
}

const pushes = collectPushes();
const routes = routeMap();

describe('跳转闭环', () => {
  it('能解析到路由表与带参跳转', () => {
    expect(Object.keys(routes).length).toBeGreaterThan(15);
    expect(pushes.length).toBeGreaterThan(3);
  });

  it('每个跳转的目标路径都存在', () => {
    const unknown = pushes
      .filter((p) => !p.path.includes(':') && !routes[p.path])
      // 动态段（如 /houses/xxx）用前缀匹配
      .filter((p) => !Object.keys(routes).some((r) => p.path.startsWith(r + '/') || p.path === r))
      .map((p) => `${p.from} → ${p.path}`);
    if (unknown.length) throw new Error('跳转到了路由表里不存在的路径：\n  ' + unknown.join('\n  '));
    expect(unknown).toEqual([]);
  });

  it('跳转带的 query 参数，目标页必须读取', () => {
    const dead: string[] = [];
    for (const p of pushes) {
      const target = routes[p.path];
      if (!target) continue; // 路径存在性由上一条用例负责
      /*
       * 必须先剥注释：原实现直接在整份源码上 includes(`query.${k}`)，于是目标页
       * 删掉真实读取、只在上方留一行提到参数名的说明注释，本用例照样通过（实测）。
       * 这与「CSS 类名把注释算作定义」是同一类错误，在另一个文件复发了。
       */
      const tsrc = fs
        .readFileSync(path.join(SRC, target), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const k of p.keys) {
        // route.query.x 与 route.query['x'] 是等价写法，后者原本会被误报为断头路
        const reads = new RegExp(`query(?:\\.${k}\\b|\\[['"\`]${k}['"\`]\\])`);
        if (!reads.test(tsrc)) dead.push(`${p.from} → ${p.path}?${k}（${target} 未读取）`);
      }
    }
    if (dead.length) {
      throw new Error(
        '以下跳转传了 query 参数但目标页从不读取，用户点下去只是换了页、上下文全丢：\n  ' +
          dead.join('\n  ') +
          '\n要么在目标页读取并生效，要么别传。',
      );
    }
    expect(dead).toEqual([]);
  });
});

/**
 * 待办角标必须在处理完之后刷新。
 *
 * 起因：Bindings 用了 refreshBadges 却没导入（点了审核直接 ReferenceError）；
 * InvoiceApplications 反过来——导入了却从没调用，于是处理完开票申请，侧栏那个
 * 数字一直挂着不消，运维会反复点进去看已经处理过的东西。
 *
 * badges.ts 统计 bindings / tickets / invoices 三类待办，对应的三个页面在动作
 * 成功后都必须刷新角标。
 */
describe('待办角标刷新', () => {
  const BADGE_PAGES: Record<string, string> = {
    bindings: 'views/Bindings.vue',
    tickets: 'views/Tickets.vue',
    invoices: 'views/InvoiceApplications.vue',
  };

  it('badges.ts 统计的每一类待办，对应页面都要调用 refreshBadges', () => {
    const badges = fs.readFileSync(path.join(SRC, 'badges.ts'), 'utf8');
    const declared = [...badges.matchAll(/^\s*(bindings|tickets|invoices):/gm)].map((m) => m[1]);
    expect(new Set(declared)).toEqual(new Set(Object.keys(BADGE_PAGES)));

    const offenders: string[] = [];
    for (const [key, rel] of Object.entries(BADGE_PAGES)) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      const imported = /import \{[^}]*refreshBadges[^}]*\} from '\.\.\/badges'/.test(src);
      if (!imported) {
        offenders.push(`${rel}（${key}）未导入 refreshBadges`);
        continue;
      }
      /*
       * 必须逐个动作检查，不能只看「出现次数 > 1」。
       *
       * Tickets.vue 里 assign/resolve 都刷了角标、close 漏了，而按出现次数判定时
       * 这条守卫一直是绿的——关闭工单同样会改变待办数（badges 统计 PENDING 工单），
       * 漏刷就让侧栏那个数字一直挂着，运维会反复点进去看已经处理过的东西。
       *
       * 判据：任何「调了写接口 + 提示成功」的函数，都必须刷角标。
       */
      const code = stripComments(src);
      for (const m of code.matchAll(/async function (\w+)\s*\([^)]*\)\s*\{/g)) {
        const at = m.index as number;
        const body = code.slice(at, code.indexOf('\n}', at));
        const writes = /method:\s*'(POST|PATCH|PUT|DELETE)'/.test(body);
        const notifies = /ElMessage\.success\(/.test(body);
        if (!writes || !notifies) continue;
        if (!body.includes('refreshBadges')) {
          offenders.push(`${rel}（${key}）→ ${m[1]}() 改了数据并提示成功，但没刷角标`);
        }
      }
    }
    if (offenders.length) {
      throw new Error('待办角标不会刷新：\n  ' + offenders.join('\n  '));
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 带批量操作的表格：换筛选条件必须先清掉勾选。
 *
 * Element Plus 的 reserve-selection 按 row-key 跨数据刷新保留勾选——翻页时不丢选择
 * 是它的本意，但配上「筛选后直接 load」就有真实后果：勾了 A 小区的 20 户，切到
 * B 小区，那 20 户仍在 selected 里，点「批量催缴」会给已经不在视野里的住户发提醒，
 * 而操作者以为自己发的是当前列表。欠费页正是这个组合。
 */
describe('批量操作的选择态', () => {
  const files = vueFiles(SRC).filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return src.includes('reserve-selection');
  });

  it('存在开了 reserve-selection 的页面（否则本条空转）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('筛选器的变更处理函数会清掉勾选', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(SRC, file);
      // 收集所有 @change="fn" 的处理函数名
      const handlers = [...src.matchAll(/@change="(\w+)"/g)].map((m) => m[1]);
      if (handlers.length === 0) continue;
      for (const fn of new Set(handlers)) {
        // 该函数体里必须出现 clearSelection
        const at = src.search(new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`));
        if (at === -1) continue; // 内联箭头等写法跳过
        const body = src.slice(at, src.indexOf('\n}', at));
        if (!body.includes('clearSelection')) {
          offenders.push(`${rel} → @change="${fn}"（函数体里没有 clearSelection）`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下页面开了 reserve-selection，但换筛选条件时不清勾选，批量操作会作用到被筛掉的行：\n  ' +
          offenders.join('\n  ') +
          '\n请让筛选的 @change 走一个先 clearSelection 再 load 的函数。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('批量操作成功后清掉勾选并重新加载', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(SRC, file);
      // 只看真正发起批量动作的函数：体内有 ElMessage.success 且有 selected
      for (const m of src.matchAll(/async function (\w+)\(\)\s*\{/g)) {
        const at = m.index as number;
        const body = src.slice(at, src.indexOf('\n}', at));
        if (!body.includes('selected.value') || !body.includes('ElMessage.success')) continue;
        if (!body.includes('clearSelection')) {
          offenders.push(`${rel} → ${m[1]}() 成功后没有 clearSelection`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '批量操作成功后必须清掉勾选，否则再点一次会对同一批重复操作：\n  ' + offenders.join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 加载失败必须留下一条能重试的路，且不能把「什么都没有」显示成「什么都没发生」。
 *
 * 两个真实例子：
 *  · Operations 的「重新检查」按钮长在 v-if="metrics" 的结论块里，而 metrics 拉失败
 *    时正好是 null —— 于是失败之后页面上再没有任何重试入口，只能刷新整页。而运维页
 *    恰恰是出问题时才来看的。它还用 Promise.all 同时拉指标与就绪度，任一失败会让
 *    两块一起消失。
 *  · MeterReadings / Reconciliations / BillRun / HouseProfile 的加载失败会渲染成
 *    「全部录完」「无差异」「没有规则」「房屋不存在」——把故障显示成好消息。
 */
describe('加载失败的可恢复性', () => {
  /** 用 api<...>() 拉数据的页面（排除纯展示与弹窗组件） */
  const pages = vueFiles(SRC).filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return /\bapi<[^>]*>\(/.test(src) && f.includes('views');
  });

  it('存在待检查的数据页（否则本条空转）', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it('并列拉多个互不依赖的接口时用 allSettled，一个失败不牵连其它', () => {
    const offenders: string[] = [];
    for (const file of pages) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(SRC, file);
      for (const m of src.matchAll(/await Promise\.all\(\[([\s\S]*?)\]\)/g)) {
        // 只看「一次并列拉 ≥2 个接口」的情况
        const calls = [...m[1].matchAll(/api<[^>]*>\(/g)].length;
        if (calls >= 2) {
          offenders.push(`${rel} → Promise.all 并列拉了 ${calls} 个接口`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下页面用 Promise.all 并列拉多个互不依赖的接口，任一失败会让所有块一起不显示：\n  ' +
          offenders.join('\n  ') +
          '\n请改用 Promise.allSettled，逐个判断 status。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('失败提示不得嵌在「有数据才渲染」的块里（否则失败时重试入口一起消失）', () => {
    const offenders: string[] = [];
    for (const file of pages) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SRC, file);
      const tpl = src.match(/<template>([\s\S]*)<\/template>/);
      if (!tpl) continue;
      // 找出失败横幅（type="error"/"warning" 且带重试按钮）所在位置
      for (const m of tpl[1].matchAll(/<el-alert[\s\S]{0,600}?<\/el-alert>/g)) {
        if (!/loadError|error/.test(m[0])) continue;
        if (!/@click="(load|reload|retry\w*)"/.test(m[0])) continue;
        // 该横幅之前不得有仍未闭合的 v-if="<数据变量>"
        const before = tpl[1].slice(0, m.index as number);
        const opens = [...before.matchAll(/<div v-if="(\w+)"/g)].map((x) => x[1]);
        const closes = (before.match(/<\/div>/g) ?? []).length;
        if (opens.length > closes && opens.length > 0) {
          offenders.push(`${rel} → 失败横幅位于 v-if="${opens[opens.length - 1]}" 内部`);
        }
      }
    }
    if (offenders.length) {
      throw new Error('失败提示被数据条件挡住了：\n  ' + offenders.join('\n  '));
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 显示给用户的「数量」不能取自被截断的列表长度。
 *
 * 住户档案的五个标签原先写 `账单（${data.bills.length}）`，而后端这些列表都带 take
 * （账单 100、缴费 50、绑定 20、报修 50、开票 20）——一旦条数达到上限，标签就永远显示
 * 「账单（100）」，物业以为这户总共只有 100 张账单。欠费页的「其中已逾期」也犯过
 * 同一类错（用截断后的 rows 现算，与合计一起少报）。
 *
 * 判据：模板里出现在中文括号内的 `.length` 一律可疑——真实总数应由服务端 count 给出。
 */
describe('计数不得取自截断列表', () => {
  /** 确实是「本页全部数据」的情况：不带 take、或本身就是前端计算出的集合 */
  const LENGTH_OK: Record<string, string> = {
    'views/BillImport.vue': '预览行来自本地解析的文件，没有截断',
    'views/Houses.vue': '批量导入的待提交行来自本地 CSV，没有截断',
    'views/MeterReadings.vue': '未录房屋列表由后端一次给全（无 take）',
  };

  it('标签/统计里的数量不用列表 .length', () => {
    const offenders: string[] = [];
    for (const file of vueFiles(SRC)) {
      const rel = path.relative(SRC, file);
      if (rel in LENGTH_OK) continue;
      const src = fs.readFileSync(file, 'utf8');
      const tpl = src.match(/<template>([\s\S]*)<\/template>/);
      if (!tpl) continue;
      // 「…（${xxx.length}）」这种给人看的计数
      for (const m of tpl[1].matchAll(/（\$\{[\w.]*\.length\}）|（\{\{[^}]*\.length[^}]*\}\}）/g)) {
        offenders.push(`${rel} → ${m[0]}`);
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下计数取自列表长度，而这些列表可能被服务端 take 截断，数字会停在上限：\n  ' +
          offenders.join('\n  ') +
          '\n请由服务端返回 count（走同一份 where、不受 take 影响），' +
          '或把该页加进 LENGTH_OK 并说明为什么不会被截断。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('空状态一律用 EmptyState 组件，而不是一行字', () => {
    /*
     * 住户档案的五个空状态原先是 <div class="pf-empty">这户还没有账单</div> —— 一行灰字，
     * 既没说「为什么空」也没说「下一步做什么」。而全站其余 24 处都用 EmptyState
     * （22 处带 desc、11 处带可点的下一步）。同一个产品里两种空状态质量。
     */
    const offenders: string[] = [];
    for (const file of vueFiles(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      const tpl = src.match(/<template>([\s\S]*)<\/template>/);
      if (!tpl) continue;
      for (const m of tpl[1].matchAll(/<template #empty>([\s\S]{0,300}?)<\/template>/g)) {
        if (!m[1].includes('<EmptyState')) {
          offenders.push(`${path.relative(SRC, file)} → ${m[1].trim().slice(0, 60)}`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下表格的空状态没有用 EmptyState，用户看不到「为什么空」与「下一步做什么」：\n  ' +
          offenders.join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });
});
