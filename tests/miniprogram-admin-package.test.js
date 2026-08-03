const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 管理端分包(物业人员用,免密:微信授权手机号匹配管理员名单)。
 *
 * 这个文件钉三类事:
 *   ① 分包边界 —— 管理端必须整个待在 packageAdmin 里,业主端零引用。
 *      这既是包体积的事(业主永不下载),也是将来拆成独立小程序的边界。
 *   ② 令牌纪律 —— 管理员令牌只放内存,绝不落存储;
 *      借手机给别人用小程序时,存储里躺着管理令牌就是事故。
 *   ③ 静默失败 —— 探测「是不是管理员」失败一律等于「不是」,
 *      普通业主的正常路径上不能弹任何错。
 */

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'apps/miniprogram');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('分包在 app.json 注册,三个页面文件齐全', () => {
  const app = JSON.parse(read('app.json'));
  const sub = (app.subpackages || []).find((s) => s.root === 'packageAdmin');
  assert.ok(sub, 'packageAdmin 分包未注册');
  for (const p of sub.pages) {
    for (const ext of ['.js', '.wxml', '.json']) {
      assert.ok(fs.existsSync(path.join(MP, 'packageAdmin', p + ext)), `缺文件 packageAdmin/${p}${ext}`);
    }
  }
  // 管理端页面绝不能出现在主包 pages 里 —— 那等于业主也下载它
  for (const p of app.pages) assert.ok(!p.includes('packageAdmin'), '管理页混进了主包');
});

test('管理员令牌只在内存,不落存储', () => {
  const src = stripJs(read('utils/admin.js'));
  assert.ok(!/setStorageSync|setStorage\(/.test(src), '管理员令牌被写进了存储');
  // 会话变量存在且换发失败会清空
  assert.match(src, /session = null/, '失败路径没有清空会话');
});

test('探测失败 = 不是管理员,静默,不打扰业主', () => {
  const src = read('utils/admin.js');
  assert.match(src, /silent: true/, '探测请求没有 silent——普通业主会看到报错 toast');
  const mine = stripJs(read('pages/mine/mine.js'));
  assert.match(mine, /exchangeAdmin\(\)\.then/, '「我的」页没有静默探测');
});

test('入口按 adminName 显隐;界面显隐只是引导,门在服务端', () => {
  const wxml = read('pages/mine/mine.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(wxml, /wx:if="\{\{adminName\}\}"[\s\S]{0,200}物业管理/, '「物业管理」入口没有按管理员身份显隐');
});

test('管理端请求走令牌覆盖;管理令牌 40100 不触发业主重登', () => {
  /*
   * request.js 的 40100 自动重登拿到的是**业主**身份 ——
   * 用它重放 /admin/* 请求只会再 401 一次并可能吞掉真实原因。
   * 管理令牌失效必须走重新换发(admin.js 自己处理)。
   */
  const req = stripJs(read('utils/request.js'));
  assert.match(req, /token \|\| getToken\(\)/, 'request 不支持令牌覆盖'); // bearer = token || getToken()
  assert.match(req, /&& !options\.token/, '管理令牌 401 走了业主重登');
  const adm = stripJs(read('utils/admin.js'));
  assert.match(adm, /token: s\.token/, 'adminRequest 没带管理员令牌');
});

test('业主端主包没有任何文件引用 packageAdmin 之外的管理逻辑', () => {
  /*
   * 允许:pages/mine 引 utils/admin(入口探测)。
   * 除此之外主包任何页面 require utils/admin 都是分包边界被打穿的信号。
   */
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(MP, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'packageAdmin') continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js') && stripJs(read(rel)).includes("utils/admin")) offenders.push(rel);
    }
  };
  walk('pages');
  assert.deepEqual(offenders, ['pages/mine/mine.js'], `管理逻辑泄出分包:${offenders.join(', ')}`);
});

test('首页是楼盘图:楼栋条 → 层格子,欠费格标金额,点格进房', () => {
  /*
   * 实测反馈:「操作特别不方便,能不能做成楼盘表格那样」。
   * 搜索是接电话用的;日常巡查靠空间视图 —— 这条钉住别退回纯搜索。
   */
  const wxml = read('packageAdmin/pages/home/home.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(wxml, /pickBuilding/, '没有楼栋切换');
  assert.match(wxml, /wx:for="\{\{u\.floors\}\}"/, '没有按层铺格子');
  assert.match(wxml, /cell-unpaid/, '欠费格没有红色状态类');
  assert.match(wxml, /\{\{item\.unpaidAmount\}\}/, '欠费格没有金额');
  assert.match(wxml, /data-id="\{\{item\.id\}\}" bindtap="goHouse"/, '格子点不进房屋详情');
  // 搜索保留:接电话查户仍是它最快
  assert.match(wxml, /bindinput="onKeywordInput"/, '搜索框被删掉了');
});
