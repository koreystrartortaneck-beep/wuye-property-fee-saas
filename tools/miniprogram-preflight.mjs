/**
 * 小程序上传前的语法预检。
 *
 * 这些错误平时只有微信开发者工具会报 —— 而开发者工具需要扫码登录，
 * 也就是说「发现问题」和「能上传」是同一个门槛：等你能上传时才知道有没有语法错，
 * 而那时错误信息还得靠图形界面看。
 *
 * 本轮改了 8 个 wxml、15 个 wxss（其中 286 处是机械替换成 var(--x, 原值)），
 * 任何一处括号或标签不匹配都会让整页白屏，而单测与静态检查都发现不了。
 *
 * 检查项：
 *   · WXSS 括号平衡、var() 语法与闭合
 *   · WXML 标签配对（引号感知，属性值里的 > 不会误判）
 *   · 全部 .js 的语法（用 node 的 Script 编译，不执行）
 *   · app.json 的 pages 与目录一一对应、tabBar 图标文件存在
 *
 * 用法：node tools/miniprogram-preflight.mjs
 * 退出码非 0 表示有问题，可直接接进上传脚本前置步骤。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const MP = 'apps/miniprogram';
const problems = [];

/** 递归收集文件 */
function walk(dir, ext, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// ── WXSS ──
for (const p of walk(MP, '.wxss')) {
  const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  if (code.split('{').length !== code.split('}').length) {
    problems.push(`${p}: 花括号不平衡`);
  }
  const opens = (code.match(/var\(/g) ?? []).length;
  const closed = (code.match(/var\([^()]*\)/g) ?? []).length;
  if (opens !== closed) problems.push(`${p}: var( 未闭合（${opens} vs ${closed}）`);
  for (const m of code.matchAll(/var\(([^()]*)\)/g)) {
    if (!m[1].trim().startsWith('--')) problems.push(`${p}: var() 参数异常 → var(${m[1].slice(0, 40)})`);
  }
}

// ── WXML ──
/** 引号感知的标签切分：属性值里的 > 不能提前结束标签 */
function tags(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); i = e < 0 ? src.length : e + 3; continue; }
    if (src[i] === '<') {
      let j = i + 1, q = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '>') break;
      }
      if (j >= src.length) return null;
      out.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const n = src.indexOf('<', i);
    i = n < 0 ? src.length : n;
  }
  return out;
}
const VOID = new Set(['image', 'input', 'br', 'icon', 'import', 'include', 'wxs']);
for (const p of walk(MP, '.wxml')) {
  const ts = tags(readFileSync(p, 'utf8'));
  if (!ts) { problems.push(`${p}: 有标签未闭合（缺 >）`); continue; }
  const stack = [];
  for (const t of ts) {
    const inner = t.slice(1, -1);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const top = stack.pop();
      if (top !== name) { problems.push(`${p}: </${name}> 与 <${top ?? '(空)'}> 不匹配`); break; }
      continue;
    }
    if (inner.endsWith('/')) continue;
    const nm = /^([a-zA-Z-]+)/.exec(inner);
    if (nm && !VOID.has(nm[1])) stack.push(nm[1]);
  }
  if (stack.length) problems.push(`${p}: 未闭合 <${stack.join('> <')}>`);
}

// ── JS 语法 ──
for (const p of walk(MP, '.js')) {
  try { new vm.Script(readFileSync(p, 'utf8'), { filename: p }); }
  catch (e) { problems.push(`${p}: ${String(e.message).split('\n')[0]}`); }
}

// ── app.json ──
const app = JSON.parse(readFileSync(join(MP, 'app.json'), 'utf8'));
for (const page of app.pages ?? []) {
  for (const ext of ['.wxml', '.js', '.json', '.wxss']) {
    if (!existsSync(join(MP, page + ext))) problems.push(`app.json 注册了 ${page} 但缺 ${ext}`);
  }
}
const registered = new Set(app.pages ?? []);
for (const d of readdirSync(join(MP, 'pages'))) {
  if (!registered.has(`pages/${d}/${d}`)) problems.push(`pages/${d} 未在 app.json 注册（不会被打包）`);
}
for (const t of app.tabBar?.list ?? []) {
  for (const k of ['iconPath', 'selectedIconPath']) {
    if (t[k] && !existsSync(join(MP, t[k]))) problems.push(`tabBar 图标缺失：${t[k]}`);
  }
  if (t.pagePath && !registered.has(t.pagePath)) problems.push(`tabBar 指向未注册页面：${t.pagePath}`);
}
void dirname;

if (problems.length) {
  console.error(`✗ 预检发现 ${problems.length} 处问题：`);
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
console.log('✓ 预检通过：WXSS 括号与 var()、WXML 标签配对、JS 语法、app.json 一致性');
