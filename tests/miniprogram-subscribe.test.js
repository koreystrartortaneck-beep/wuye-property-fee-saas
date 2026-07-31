const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 订阅额度必须在多个自然节点累积。
 *
 * 微信不给物业管理类目开「长期订阅」（只对政务民生/医疗/交通/金融/教育等线下公共
 * 服务开放），只能用一次性订阅——业主授权一次只能收到一条。线上实测：一次授权后
 * 发两条，第 1 条 SENT、第 2 条 43101。
 *
 * 弥补办法是利用授权弹窗的「总是保持以上选择，不再询问」：勾过之后后续调用自动
 * 通过且不弹窗，所以要在业主本来就会点的节点都调一次，无感累积。
 * 若哪天这些调用被删掉，业主又会回到「不主动去点就收不到通知」的状态。
 */
const MP = path.join(__dirname, '..', 'apps', 'miniprogram');

function read(rel) {
  return fs.readFileSync(path.join(MP, rel), 'utf8');
}

test('订阅工具导出累积额度与读取状态的能力', () => {
  const src = read('utils/subscribe.js');
  for (const fn of ['requestSubscribe', 'accrueSubscribeQuota', 'getSubscribeState']) {
    assert.match(src, new RegExp(`\\b${fn}\\b`), `utils/subscribe.js 缺少 ${fn}`);
  }
  // 读状态必须带 withSubscriptions，否则拿不到 subscriptionsSetting
  assert.match(src, /withSubscriptions:\s*true/, 'getSetting 必须带 withSubscriptions: true');
  // 总开关关闭时任何模板都发不出去，必须单独判
  assert.match(src, /mainSwitch/, '必须判断订阅总开关 mainSwitch');
});

test('业主自然会点的节点都要累积额度（否则不主动点就收不到通知）', () => {
  const points = {
    'pages/bill/bill.js': '账单页点开某张账单',
    'pages/pay-success/pay-success.js': '缴费成功页',
    'pages/index/index.js': '首页主按钮',
    'pages/pay-confirm/pay-confirm.js': '支付确认页',
    'pages/mine/mine.js': '我的 → 缴费提醒',
  };
  const missing = [];
  for (const [rel, label] of Object.entries(points)) {
    const src = read(rel);
    if (!/accrueSubscribeQuota|requestSubscribe/.test(src)) missing.push(`${rel}（${label}）`);
  }
  assert.deepStrictEqual(
    missing,
    [],
    `以下节点没有请求订阅授权，业主的额度会不够用：\n  ${missing.join('\n  ')}`,
  );
});

test('「我的」页按真实状态显示，且 ban 状态给出微信设置路径', () => {
  const src = read('pages/mine/mine.js');
  assert.match(src, /refreshNotifyState/, '必须按真实授权状态改写说明文字');
  assert.match(src, /notifyState/, 'data 里要有 notifyState');
  // ban 时再弹窗也弹不出来，必须引导去右上角设置
  assert.match(src, /'ban'/, '必须单独处理 ban 状态');
  assert.match(src, /订阅消息/, 'ban 时要给出「设置 → 订阅消息」的路径');
});
