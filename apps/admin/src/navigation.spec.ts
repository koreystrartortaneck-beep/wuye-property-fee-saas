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
      const tsrc = fs.readFileSync(path.join(SRC, target), 'utf8');
      for (const k of p.keys) {
        if (!tsrc.includes(`query.${k}`)) dead.push(`${p.from} → ${p.path}?${k}（${target} 未读取）`);
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
