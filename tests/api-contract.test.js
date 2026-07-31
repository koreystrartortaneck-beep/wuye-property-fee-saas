const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 两个前端调用的每一个后端路径都必须真实存在。
 *
 * 这类缺陷没有任何单元测试能覆盖：前端调 `/admin/xxx`，后端把路由改名或删了，
 * 编译过、单测过、部署也成功，只有用户点到那个按钮时才 404 ——
 * 而 40400 同时表示「端点不存在」与「记录不存在」，看到它也判断不出是哪种。
 *
 * 本仓已经为此白花过十几分钟（找一个「明明部署了却 404」的端点）。
 *
 * 特别处理**动态拼出来的动作名**（`/admin/service-orders/${id}/${action}`）：
 * 静态扫描只能看到两个占位符，而 action 的取值来自 TS 联合类型。
 * 这些必须在下面显式展开 —— 它们恰恰是最容易 404 的形状：
 * 后端把 accept 改成 take 之后，前端那一个按钮静默失效，其它按钮照常工作。
 */

const ROOT = path.join(__dirname, '..');

// ────────────────────────── 后端路由表 ──────────────────────────

function collectRoutes() {
  const routes = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.controller.ts') && !e.name.includes('.spec.')) {
        const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        // 一个文件可能有多个 @Controller（upload.controller.ts 就有两个），必须分段
        const ctrlRe = /@Controller\(\s*'([^']*)'\s*\)/g;
        let cm;
        const segs = [];
        while ((cm = ctrlRe.exec(src))) segs.push({ prefix: cm.group ?? cm[1], start: cm.index });
        for (let i = 0; i < segs.length; i++) {
          const seg = src.slice(segs[i].start, i + 1 < segs.length ? segs[i + 1].start : src.length);
          const mRe = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
          let mm;
          while ((mm = mRe.exec(seg))) {
            const parts = [segs[i].prefix, mm[2] || ''].filter(Boolean);
            routes.push({ method: mm[1].toUpperCase(), path: `/${parts.join('/')}` });
          }
        }
      }
    }
  };
  walk(path.join(ROOT, 'apps', 'api', 'src'));
  return routes;
}

const ROUTES = collectRoutes();

/**
 * 路径是否命中某条路由。
 *
 * 关键点：**字面量段不接受被 `:param` 匹配**。
 *
 * 起初写的是「`:param` 与任意一段匹配」，于是把 @Get('by-period') 改名之后
 * 测试照样全绿 —— 因为 `/owner/bills/by-period` 会被 `/owner/bills/:id` 吞掉
 * （段数相同）。而这恰恰是本仓今天真实踩过的冲突：静态路径与 :id 抢同一个 URL。
 * 靠 :param 兜住等于这条守卫对所有「:id 兄弟路径」完全失效。
 *
 * 规则：调用路径里的 `ID` 段（来自模板插值）可以匹配 `:param`；
 * 字面量段必须逐字相等。
 */
function routeExists(urlPath, method) {
  const pp = urlPath.split('/').filter(Boolean);
  return ROUTES.some((r) => {
    if (method && r.method !== method) return false;
    const rp = r.path.split('/').filter(Boolean);
    if (rp.length !== pp.length) return false;
    return rp.every((a, i) => {
      if (a.startsWith(':')) return pp[i] === 'ID';
      return a === pp[i];
    });
  });
}

// ────────────────────────── 前端调用路径 ──────────────────────────

/**
 * 把模板字符串里的插值归一化。
 *
 * `${qs({...})}` 是查询串、不是路径段，必须整段去掉；其余插值换成一个占位段。
 * 用括号计数而不是正则：`${qs({ page, pageSize })}` 里有嵌套花括号，
 * 正则 `\$\{[^}]*\}` 会在第一个 `}` 截断，留下半截 `${qs` ——
 * 我第一版就是这么误报了 26 个路径。
 */
function normalize(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('${', i)) {
      let depth = 0;
      let j = i + 1;
      for (; j < raw.length; j++) {
        if (raw[j] === '{') depth++;
        else if (raw[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const seg = raw.slice(i, j + 1);
      out += /\bqs\s*\(/.test(seg) ? '' : 'ID';
      i = j + 1;
    } else {
      out += raw[i];
      i++;
    }
  }
  return out.split('?')[0].replace(/\/+$/, '');
}

function collectCalls(dirs, exts) {
  const calls = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x)) && !/\.(spec|test)\./.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/['"`](\/(?:owner|admin|auth|payment|health)[^'"`]*)/g)) {
          calls.add(m[1]);
        }
      }
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  return [...calls];
}

/**
 * 动态动作名的展开表。
 * 键是归一化后的路径（动作那一段是 ID），值是该处所有可能的动作。
 */
const DYNAMIC_ACTIONS = {
  '/admin/bills/ID/ID': ['cancel', 'reissue'],
  '/admin/operations/incidents/ID/ID': ['acknowledge', 'resolve'],
  '/admin/service-orders/ID/ID': ['accept', 'done', 'cancel'],
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('后端路由表解析得出来（解析器坏掉会让后续断言全部空转）', () => {
  assert.ok(ROUTES.length > 100, `只解析到 ${ROUTES.length} 条路由`);
  assert.ok(routeExists('/admin/bills', 'GET'), '应能命中 GET /admin/bills');
  assert.ok(routeExists('/owner/bills/by-period', 'GET'), '应能命中 GET /owner/bills/by-period');
  // 反向：不存在的路径不能被认成存在
  assert.ok(!routeExists('/admin/definitely-not-a-route', 'GET'));
  /*
   * 关键自检：字面量段不得被 :param 吞掉。
   * /owner/bills/:id 存在，但 /owner/bills/不存在的静态段 不能因此算「存在」——
   * 否则这条守卫对所有「:id 兄弟路径」失效（by-period 改名不报错就是这么来的）。
   */
  assert.ok(!routeExists('/owner/bills/no-such-static-path', 'GET'));
  // 而插值段（ID）应该匹配 :id
  assert.ok(routeExists('/owner/bills/ID', 'GET'));
});

test('归一化能处理 ${qs({...})} 这种嵌套花括号', () => {
  // 第一版用正则在第一个 } 截断，留下 `${qs`，误报了 26 个路径
  assert.strictEqual(normalize('/admin/bills${qs({ page, pageSize })}'), '/admin/bills');
  assert.strictEqual(normalize('/admin/bills/${row.id}/cancel'), '/admin/bills/ID/cancel');
  assert.strictEqual(normalize('/admin/houses?communityId=x'), '/admin/houses');
});

for (const [label, dirs, exts] of [
  ['小程序', ['apps/miniprogram'], ['.js']],
  ['后台', ['apps/admin/src'], ['.ts', '.vue']],
]) {
  test(`${label}调用的路径后端都有`, () => {
    const missing = [];
    let checked = 0;
    for (const raw of collectCalls(dirs, exts)) {
      const n = normalize(raw);
      if (!/^\/(owner|admin|auth|payment|health)\//.test(n) && n !== '/health') continue;
      const candidates = DYNAMIC_ACTIONS[n] ? DYNAMIC_ACTIONS[n].map((a) => n.replace(/ID$/, a)) : [n];
      for (const c of candidates) {
        checked++;
        if (!routeExists(c)) missing.push(`${raw}  →  ${c}`);
      }
    }
    // 自检：真的扫到了一批路径
    assert.ok(checked > 20, `${label}只检查了 ${checked} 个路径，收集器可能坏了`);
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
  });
}

test('动态动作表里的动作确实存在（表本身也会过期）', () => {
  /*
   * 这张表是手写的：后端把 accept 改名后，若只改前端联合类型而忘了改表，
   * 上面那条断言会去查一个不再被使用的动作，看起来仍然通过。
   * 这里反过来钉：表里列的每个动作都必须是后端真有的路由。
   */
  const bad = [];
  for (const [tpl, actions] of Object.entries(DYNAMIC_ACTIONS)) {
    for (const a of actions) {
      const p = tpl.replace(/ID$/, a);
      if (!routeExists(p, 'POST')) bad.push(`POST ${p}`);
    }
  }
  assert.deepStrictEqual(bad, [], `\n  ${bad.join('\n  ')}`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✕ ${name}\n    ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
