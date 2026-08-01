const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 支付成功必须**立刻**反馈，不许让业主等我们记账。
 *
 * 这是 2026-08-01 事故暴露的设计问题，不是技术限制。原来的流程是：
 *
 *     await wx.requestPayment(...)              // 微信已确认扣款，钱这一刻就付完了
 *     wx.showLoading({ title: '确认支付结果' })  // 却在这里把业主挡住
 *     await waitForPaymentConfirmation(...)      // 等我们自己的入账
 *
 * 两件不同的事被混成了一件：
 *   · 「业主付了吗」—— 微信当场就答了，是权威结论
 *   · 「我们记上了吗」—— 我们的内部记账，不该由业主承担这段等待
 *
 * 于是业主付完款先看到转圈、再看到一个解释性弹框，而他要的只是「缴清了」。
 * 事故里这段等待最长拖了 42 分钟。
 *
 * 现在：requestPayment 成功即进成功页；入账在后台推进；
 * 中间那个窗口在账单页显示「入账中」而不是「待缴」。
 */

const MP = path.join(__dirname, '..', 'apps/miniprogram');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ───────────────── 立刻反馈 ─────────────────

test('requestPayment 成功后不再阻塞等待入账', () => {
  const src = stripComments(read('pages/pay-confirm/pay-confirm.js'));
  const after = src.slice(src.indexOf('wx.requestPayment'));

  // 不能再出现「确认支付结果」这个阻塞态
  assert.ok(!after.includes('确认支付结果'), '仍在支付后显示阻塞式 loading');

  /*
   * 关键：waitForPaymentConfirmation 不能被 await。
   * 它仍然要被调用（触发查单让入账尽快发生），但必须是 fire-and-forget。
   */
  assert.ok(after.includes('waitForPaymentConfirmation'), '完全不触发查单会让入账变慢');
  assert.ok(
    !/await\s+waitForPaymentConfirmation/.test(after),
    'waitForPaymentConfirmation 仍被 await —— 业主又被挡住了',
  );
  // 未捕获的 Promise 拒绝会在真机上打出错误，必须挂 catch
  assert.match(after, /waitForPaymentConfirmation\([^)]*\)\s*\.catch\(/, '缺少 .catch');
});

test('支付成功后直接跳成功页，中间不插弹框', () => {
  /*
   * 切片必须只取 requestPayment 那个分支。
   * 第一版从 requestPayment 一直切到 pay-success，把紧随其后的 else 分支
   * （PREPAY_UNKNOWN 的「支付结果确认中」弹框）也圈了进来，于是误报 ——
   * 那个弹框根本不在支付成功的路径上。
   */
  const src = stripComments(read('pages/pay-confirm/pay-confirm.js'));
  const start = src.indexOf('wx.requestPayment');
  const branchEnd = src.indexOf('} else {', start);
  assert.ok(start > 0 && branchEnd > start, '找不到 requestPayment 分支');
  const branch = src.slice(start, branchEnd);
  assert.ok(!branch.includes('showModal'), '支付成功路径上仍有弹框拦着');
  assert.ok(!branch.includes('showLoading'), '支付成功路径上仍有阻塞式 loading');
});

// ───────────────── 成功页要能处理「还没入账」 ─────────────────

test('成功页不谎称「已实时入账」', () => {
  /*
   * 必须先剥掉 HTML 注释：注释里也写了「已实时入账」（解释为什么要把门），
   * indexOf 会先命中注释，于是拿注释前面的文本去找 wx:if —— 永远找不到。
   * 第一版就是这么误报的。
   */
  const wxml = read('pages/pay-success/pay-success.wxml').replace(/<!--[\s\S]*?-->/g, '');
  /*
   * 标题仍是「缴费成功」——微信扣款成功是事实。
   * 但「已实时入账」这句在账单还没销账时是假的，必须由 settled 把门。
   */
  assert.ok(wxml.includes('缴费成功'), '不该弱化「缴费成功」这个结论');
  const idx = wxml.indexOf('已实时入账');
  assert.ok(idx > 0, '找不到入账文案');
  const before = wxml.slice(Math.max(0, idx - 200), idx);
  assert.match(before, /wx:if="\{\{settled\}\}"/, '「已实时入账」没有被 settled 把门');
  assert.ok(wxml.includes('正在同步'), '未入账时没有给出如实说明');
});

test('未入账时收据入口先禁用——点开只会是空页', () => {
  const wxml = read('pages/pay-success/pay-success.wxml');
  const btn = wxml.slice(wxml.indexOf('viewReceipt'));
  assert.match(btn.slice(0, 300), /disabled="\{\{!settled\}\}"/, '收据按钮未按 settled 禁用');
});

test('成功页在后台安静轮询，且离开页面后停止', () => {
  const src = stripComments(read('pages/pay-success/pay-success.js'));
  assert.ok(src.includes('waitForPaymentConfirmation'), '未入账时没有任何推进');
  // 不许出现阻塞式 loading / 弹框：业主的支付已经完成了
  assert.ok(!src.includes('showLoading'), '成功页出现了阻塞式 loading');
  assert.ok(!src.includes('showModal'), '成功页出现了弹框');
  /*
   * onUnload 后必须停：setData 到已销毁的页面会报错，也白耗请求。
   * 这类「页面走了还在刷」的问题在真机上表现为偶发报错，很难查。
   */
  assert.ok(src.includes('onUnload'), '没有处理页面离开');
  /*
   * 必须按**函数体**断言。第一版在整份源码上匹配 /if \(this\.left\) return/，
   * 而 fetchOrder 里也有一处同样的判断 —— 把 pollSettlement 里的删掉之后
   * 正则仍然命中，测试照样全绿。这正是这条守卫要拦的漏法。
   */
  const poll = src.slice(src.indexOf('async pollSettlement'));
  const body = poll.slice(0, poll.indexOf('\n  },'));
  assert.ok(body.length > 0, '找不到 pollSettlement');
  assert.match(body, /if \(this\.left\) return;/, 'pollSettlement 在页面离开后仍会 setData');
  // 且这道判断要在刷新之前，否则等于没判
  assert.ok(
    body.indexOf('this.left') < body.indexOf('fetchOrder'),
    'this.left 的判断在刷新之后，等于没判',
  );
});

// ───────────────── 账单页的「入账中」 ─────────────────

test('账单列表用「入账中」而不是「待缴」', () => {
  const js = stripComments(read('pages/bill/bill.js'));
  assert.ok(js.includes('入账中'), '列表没有「入账中」状态');
  assert.match(js, /settling\s*=\s*b\.status === 'UNPAID' && b\.settling/, 'settling 判定不对');
  // 入账中不能再当成可缴费：否则业主会为同一笔账单付第二次
  assert.match(js, /paid:\s*b\.status !== 'UNPAID' \|\| settling/, '入账中的账单仍显示为可缴费');
  // 逾期与入账中互斥：钱已经付了，不该再骂他逾期
  assert.match(js, /overdue\s*=\s*!settling/, '入账中的账单可能同时被标成已逾期');
});

test('入账中的样式有定义，且能压过「已缴」的样式', () => {
  const wxml = read('pages/bill/bill.wxml');
  const wxss = read('pages/bill/bill.wxss');
  assert.ok(wxml.includes('status-settling'), 'wxml 没用上 status-settling');
  assert.ok(wxss.includes('.status-settling'), 'wxss 没有定义 .status-settling');
  /*
   * settling 的行同时带 status-paid 与 status-settling 两个类
   * （paid 为 true 才能收起缴费入口），后定义的赢，所以顺序必须对。
   * 顺序错了不会报错，只会「颜色不对」——这种缺陷肉眼很难发现。
   */
  assert.ok(
    wxss.indexOf('.status-paid') < wxss.indexOf('.status-settling'),
    '.status-settling 必须定义在 .status-paid 之后',
  );
});

test('账单详情页与列表口径一致，且收起缴费按钮', () => {
  /*
   * 两处口径不一致最危险：列表说「入账中」不给按钮，详情说「待缴」给按钮，
   * 业主点进去就付了第二次。
   */
  const js = stripComments(read('pages/bill-detail/bill-detail.js'));
  const wxml = read('pages/bill-detail/bill-detail.wxml');
  assert.ok(js.includes('入账中'), '详情页没有「入账中」');
  assert.match(js, /overdue\s*=\s*!settling/, '详情页的逾期判定没有排除 settling');
  // 按钮必须同时看 status 和 settling
  assert.match(
    wxml,
    /wx:if="\{\{bill\.status === 'UNPAID' && !bill\.settling\}\}"/,
    '详情页缴费按钮没有排除 settling',
  );
  // 点击处理也要拦一道，防旧数据/竞态
  assert.match(js, /b\.status !== 'UNPAID' \|\| b\.settling/, 'goPay 没有二次拦截');
  assert.ok(wxml.includes('请勿重复支付'), '没有告诉业主不要重复支付');
});
