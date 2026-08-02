const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

/**
 * 「我现在看到的是不是最新代码？」—— 2026-08-02 业主问的这个问题当时答不上来。
 *
 * 当时唯一的办法是**数「我的」页有几个菜单项**（改动前 7 个、改动后 5 个），
 * 靠可见差异反推版本。这个办法有个致命的适用范围问题：
 * 一旦某次改动**没有**可见差异（纯逻辑、超时值、拦截条件——那天改的一多半都是），
 * 就彻底无从判断，只能猜「大概编译过了吧」。
 *
 * 于是在「我的」页底放了一个内容指纹。但指纹这东西一旦过期就是**反作用**：
 * 屏幕上显示 abc1234、你以为是最新的，其实源码早改了没重算 ——
 * 比没有指纹更糟，因为它给的是「已确认」的错觉。
 *
 * 所以这个文件钉的是：指纹必须与源码同步。
 *
 * 注意所有「改一下看指纹变不变」的验证都在**临时副本**上做。
 * 第一版直接改真实工作区的文件再还原，两个后果当场就撞上了：
 *   · node --test 多进程并发，别的测试正在读同一批文件 → 它们红在我的扰动上
 *   · 还原依赖 finally，中途一崩就把用户未提交的改动留成了脏状态
 */

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'apps/miniprogram');
const STAMPER = path.join(ROOT, 'tools/stamp-miniprogram.mjs');
const VERSION_FILE = path.join(MP, 'utils/version.js');

const run = (...args) => execFileSync('node', [STAMPER, ...args], { encoding: 'utf8' }).trim();

/** 在小程序目录的一次性副本上算指纹；mutate 可先改动副本 */
async function stampOfCopy(t, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-stamp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, 'miniprogram');
  /*
   * 必须跳过点开头的文件：并发跑测试时，别的用例的探针
   * （utils/.upload-timeout-probe.js）可能在 cpSync 走到它之前就被删了 → ENOENT。
   * 它们本来也不参与指纹计算，复制过来没有意义。
   */
  fs.cpSync(MP, copy, { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
  if (mutate) mutate(copy);
  const { computeStamp } = await import(`file://${STAMPER}`);
  return computeStamp(copy);
}

test('指纹与当前源码一致——过期的指纹比没有指纹更危险', () => {
  /*
   * 这条会在「改了小程序但忘了重算指纹」时变红。
   * 修法就一行：node tools/stamp-miniprogram.mjs
   */
  const expected = run('--print');
  const actual = /BUILD\s*=\s*'([^']*)'/.exec(fs.readFileSync(VERSION_FILE, 'utf8'))?.[1];
  assert.equal(actual, expected, '指纹过期，请运行 node tools/stamp-miniprogram.mjs');
});

test('指纹不把自己算进去——否则永远收敛不了', async (t) => {
  /*
   * version.js 里写的就是哈希结果。若它参与计算，
   * 写入 → 内容变 → 哈希变 → 又要写入，反复横跳，--check 永远红。
   */
  const before = await stampOfCopy(t);
  const after = await stampOfCopy(t, (dir) =>
    fs.appendFileSync(path.join(dir, 'utils/version.js'), '\n// 扰动\n'),
  );
  assert.equal(after, before, 'version.js 的内容影响了指纹，存在自指');
});

test('点开头的临时探针不算进指纹——否则指纹会随「有没有别的测试在跑」而漂', async (t) => {
  /*
   * utils/.upload-timeout-probe.js 是 miniprogram-hang-and-scope 的探针，
   * 它必须落在源码目录里（被测模块 require 的是 '../config' 这类相对路径）。
   * 一个会漂的指纹不能用来判断「是不是最新代码」。
   */
  const before = await stampOfCopy(t);
  const after = await stampOfCopy(t, (dir) =>
    fs.writeFileSync(path.join(dir, 'utils/.probe.js'), 'module.exports = {};\n'),
  );
  assert.equal(after, before, '临时探针文件影响了指纹');
});

test('改任何一个源码文件，指纹都要变', async (t) => {
  const before = await stampOfCopy(t);
  const after = await stampOfCopy(t, (dir) =>
    fs.appendFileSync(path.join(dir, 'pages/mine/mine.wxss'), '\n/* 扰动 */\n'),
  );
  assert.notEqual(after, before, '改了 wxss 指纹却没变——指纹覆盖不到样式');
});

test('只改文件名也要变——重命名不能悄悄溜过去', async (t) => {
  /*
   * 若只把文件内容拼进哈希，「a.js 删掉 + b.js 新增同样内容」算出来是同一个值。
   * 页面路径改名恰恰是这种形状，而它是会真的改变运行结果的。
   */
  const before = await stampOfCopy(t);
  const after = await stampOfCopy(t, (dir) =>
    fs.renameSync(path.join(dir, 'utils/labels.js'), path.join(dir, 'utils/labels-renamed.js')),
  );
  assert.notEqual(after, before, '文件重命名后指纹未变——路径没进哈希');
});

test('指纹真的显示在「我的」页上——只生成不展示等于没做', () => {
  const wxml = fs.readFileSync(path.join(MP, 'pages/mine/mine.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(MP, 'pages/mine/mine.js'), 'utf8');
  assert.match(wxml, /\{\{build\}\}/, '「我的」页没有渲染指纹');
  assert.match(js, /require\('\.\.\/\.\.\/utils\/version'\)/, 'mine.js 没有引入 version');
  assert.match(js, /build:\s*BUILD/, 'build 没有进 data，模板里取不到值');
});

test('--check 在指纹过期时以非零退出——CI 里才拦得住', (t) => {
  /*
   * 这一条只能在真实工作区上验（--check 读的就是真文件），
   * 所以改的是 version.js 这一个由工具生成的文件，且 after 钩子无条件还原。
   */
  const original = fs.readFileSync(VERSION_FILE, 'utf8');
  t.after(() => fs.writeFileSync(VERSION_FILE, original));
  fs.writeFileSync(VERSION_FILE, original.replace(/BUILD\s*=\s*'[^']*'/, "BUILD = 'stale00'"));
  assert.throws(() => run('--check'), '指纹过期时 --check 仍然通过了');
});

test('上传脚本会自动刷新指纹，且排在预检之前', () => {
  /*
   * 顺序要紧：刷新指纹会改写 version.js，也就是改变了要上传的代码。
   * 预检必须看到最终那一份。
   */
  const sh = fs.readFileSync(path.join(ROOT, 'upload-miniprogram.sh'), 'utf8');
  const iStamp = sh.indexOf('stamp-miniprogram.mjs');
  const iPre = sh.indexOf('miniprogram-preflight.mjs');
  assert.ok(iStamp > 0, '上传脚本没有刷新指纹——上传出去的会是过期版本号');
  assert.ok(iStamp < iPre, '刷新指纹排在了预检之后');
});
