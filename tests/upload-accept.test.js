const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 文件选择器接受的类型必须与后端一致。
 *
 * 原来后台写的是通配（image 斜杠星号），而后端只接受 jpeg/png/webp：
 * 用户在 iPhone 上选一张默认格式（HEIC）的照片，选得到、传不上去，
 * 得到的提示是「上传失败」而不是「不支持这种格式」——他会反复试。
 */
const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('后台上传的 accept 与后端 ALLOWED 一致', () => {
  const backend = fs.readFileSync(path.join(ROOT, 'apps/api/src/upload/upload.controller.ts'), 'utf8');
  const allowed = /const ALLOWED = new Set\(\[([^\]]*)\]\)/.exec(backend);
  assert.ok(allowed, '后端 ALLOWED 集合被改名了？请同步本测试');
  const types = [...allowed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.ok(types.length >= 3, `只解析到 ${types.length} 种类型，解析器可能坏了`);

  const vue = fs.readFileSync(path.join(ROOT, 'apps/admin/src/views/WorkLogs.vue'), 'utf8');
  const accept = /accept="([^"]+)"/.exec(vue);
  assert.ok(accept, 'WorkLogs.vue 的 accept 属性不见了？');
  const front = accept[1].split(',').map((x) => x.trim()).sort();
  assert.deepStrictEqual(front, types, '前端 accept 与后端 ALLOWED 不一致');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✕ ${name}\n    ${e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
