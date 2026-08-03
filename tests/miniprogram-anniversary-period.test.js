const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 按户周年账期在业主端的呈现。
 *
 * 后端的账期标签从这一版起有第四种格式:'2026-03-15'(每户各自的年度起始日)。
 * 业主端的约定:
 *   · 列表分组头只显示「2026 年度」—— 18 字符的完整起止塞进 flex 行
 *     会把右侧小计挤掉行,这类挤压已经咬过三次
 *   · 完整起止(2026-03-15 ~ 2027-03-14)放详情页,来自账单 snapshot
 *   · 渠道开关(selfApply)关掉的小区,选完即提示联系物业,不进选房流程
 */

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'apps/miniprogram');
const labels = require(path.join(MP, 'utils/labels.js'));
const readWxml = (p) => fs.readFileSync(path.join(MP, p), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

test('periodLabel:四种账期格式各得其所', () => {
  assert.equal(labels.periodLabel('2026-03-15'), '2026 年度'); // 周年:只显年度
  assert.equal(labels.periodLabel('2026-07'), '2026-07'); // legacy 月度原样
  assert.equal(labels.periodLabel('2026-Q3'), '2026-Q3'); // legacy 季度原样
  assert.equal(labels.periodLabel('2026'), '2026 年'); // legacy 年度
  assert.equal(labels.periodLabel(''), '');
  assert.equal(labels.periodLabel(undefined), '');
});

test('账单列表分组头用 periodText,不再裸渲染 period', () => {
  const wxml = readWxml('pages/bill/bill.wxml');
  assert.match(wxml, /\{\{group\.periodText\}\}/, '分组头没有用格式化标签');
  assert.ok(!/class="group-period">\{\{group\.period\}\}/.test(wxml), '还在裸渲染 period 字符串');
  const js = fs.readFileSync(path.join(MP, 'pages/bill/bill.js'), 'utf8');
  assert.match(js, /periodText: labels\.periodLabel\(/, 'buildGroups 没有生成 periodText');
});

test('账单详情:周年账单显示完整起止,legacy 账单原样', () => {
  const js = fs.readFileSync(path.join(MP, 'pages/bill-detail/bill-detail.js'), 'utf8');
  assert.match(js, /b\.snapshot && b\.snapshot\.periodStart/, '详情页没有读 snapshot 里的账期起止');
  assert.match(js, /periodStart\}.*~.*periodEnd\}/s, '起止没有拼成「A ~ B」');
  const wxml = readWxml('pages/bill-detail/bill-detail.wxml');
  assert.match(wxml, /\{\{bill\.periodText\}\}/, '详情页没有用 periodText');
});

test('selfApply 关掉的小区:提示联系物业,选房流程整段不渲染', () => {
  /*
   * UI 只是提示,真正的强制在服务端(POST /owner/bindings 拒绝)。
   * 但 UI 不拦的话,业主填完一整个表单、点提交才被拒 —— 白填一遍。
   */
  const wxml = readWxml('pages/bind-house/bind-house.wxml');
  assert.match(wxml, /wx:if="\{\{selfApplyOff\}\}"/, '没有关闭提示');
  assert.ok(/联系物业登记您的手机号/.test(wxml), '提示没有给出可行的下一步');
  assert.match(wxml, /wx:if="\{\{!selfApplyOff\}\}"/, '选房流程没有按开关显隐');

  const js = fs.readFileSync(path.join(MP, 'pages/bind-house/bind-house.js'), 'utf8');
  // 旧 API 没有 binding 字段 → 按「开」处理(与服务端缺省一致),不能反过来全锁死
  assert.match(js, /community\.binding && community\.binding\.selfApply === false/, '缺省应视为开放,只有显式 false 才关');
  // 换小区时归位,否则 A 小区的关闭状态带进 B 小区
  assert.match(js, /resetCommunity\(\) \{[\s\S]*?selfApplyOff: false/, 'resetCommunity 没有归位 selfApplyOff');
});
