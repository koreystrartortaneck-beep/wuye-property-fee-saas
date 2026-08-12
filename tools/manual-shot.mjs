#!/usr/bin/env node
/*
 * 手册插图渲染:wxml-preview 的单页封装(fixture 从 JSON 文件读)。
 * 用法: node tools/manual-shot.mjs <页面路径,如 packageAdmin/pages/x/x> <fixture.json> <输出.png> [导航栏标题|-]
 * 前身是 scratchpad 里的 manual-shots.mjs —— 临时目录被清过一次,教训:基架进仓库。
 * 裁切规则见 docs/使用手册/README.md(顶部 88px 微信外壳保留)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(decodeURIComponent(new URL('.', import.meta.url).pathname), '..');
const MP = `${ROOT}/apps/miniprogram`;
const [dir, fixture, out, chromeTitle = '-'] = process.argv.slice(2);
if (!dir || !fixture || !out) {
  console.error('用法: node tools/manual-shot.mjs packageAdmin/pages/xx/xx fixture.json out.png [标题|-]');
  process.exit(1);
}
// 入参是 app.json 风格的页面路径(目录/同名文件,不带扩展名)
const parts = dir.split('/');
const base = parts.pop();
const folder = parts.join('/');
// 展开一层 @import(预览工具不解析 import)
const flat = (p) =>
  readFileSync(p, 'utf8').replace(/@import\s+"([^"]+)";/g, (_, rel) => readFileSync(resolve(dirname(p), rel), 'utf8'));
const tmp = `/tmp/mshot-${base}`;
writeFileSync(`${tmp}.wxss`, flat(`${MP}/${folder}/${base}.wxss`));
execFileSync('node', [
  `${ROOT}/tools/wxml-preview.mjs`, `${MP}/${folder}/${base}.wxml`, `${tmp}.wxss`, `${MP}/app.wxss`,
  fixture, `${tmp}.html`, base, chromeTitle,
]);
execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=375,880',
  `--screenshot=${out}`, '--default-background-color=FFFFFFFF', `file://${tmp}.html`,
]);
console.log('✓', out);
