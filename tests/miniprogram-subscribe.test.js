const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 订阅授权：既不能一次都不问，也不能到处乱问。
 *
 * 微信不给物业管理类目开「长期订阅」（只对政务民生/医疗/交通/金融/教育等线下公共
 * 服务开放），只能用一次性订阅——业主授权一次只能收到一条。线上实测：一次授权后
 * 发两条，第 1 条 SENT、第 2 条 43101。
 *
 * 这个文件原来要求「在业主本来就会点的节点都调一次」来无感累积额度，依据是
 * 授权弹窗里的「总是保持以上选择，不再询问」。**那个依据不成立**：
 * 大多数业主没勾过它，于是点每一张账单都弹一次授权框
 * ——「为什么随便点一个按钮都要订阅一次消息通知」正是业主的原话。
 * 而反复弹、反复被关掉只会把人推到 reject/ban，那之后连该发的提醒也发不出去，
 * 比从不打扰更糟。
 *
 * 现在的取舍：只在**与提醒本身相关**的时刻问，且有冷却期。
 * 但「一次都不问」同样是缺陷 —— 不主动去「我的」的业主永远收不到通知。
 * 所以这里保留的关切没变，只是换了落点：
 *   · 必须存在一个非设置页的请求点（缴费时），否则等于没有
 *   · 不许扩散到纯跳转（由 tests/subscribe-restraint.test.js 逐个函数体钉住）
 */
const MP = path.join(__dirname, '..', 'apps', 'miniprogram');

function read(rel) {
  return fs.readFileSync(path.join(MP, rel), 'utf8');
}

test('订阅工具导出请求、节流与读取状态的能力', () => {
  const src = read('utils/subscribe.js');
  for (const fn of ['requestSubscribe', 'maybeRequestSubscribe', 'getSubscribeState']) {
    assert.match(src, new RegExp(`\\b${fn}\\b`), `utils/subscribe.js 缺少 ${fn}`);
  }
  // 读状态必须带 withSubscriptions，否则拿不到 subscriptionsSetting
  assert.match(src, /withSubscriptions:\s*true/, 'getSetting 必须带 withSubscriptions: true');
  // 总开关关闭时任何模板都发不出去，必须单独判
  assert.match(src, /mainSwitch/, '必须判断订阅总开关 mainSwitch');
});

test('必须存在一个非设置页的请求点，否则不主动点的业主永远收不到通知', () => {
  /*
   * 这条是「别修过头」的保护。把所有请求点都删掉，弹窗骚扰是没了，
   * 但只有主动进「我的 → 缴费提醒」的人才会收到提醒 —— 绝大多数业主不会去点，
   * 于是出账、到期、逾期三种提醒对他们等于不存在。
   *
   * 缴费时是唯一合适的时刻：提醒讲的就是账单，业主此刻的意图与它一致。
   */
  const points = {
    'pages/pay-confirm/pay-confirm.js': '支付确认页（缴费时）',
    'pages/mine/mine.js': '我的 → 缴费提醒（业主主动）',
  };
  const missing = [];
  for (const [rel, label] of Object.entries(points)) {
    const src = read(rel);
    if (!/\b(maybeRequestSubscribe|requestSubscribe)\s*\(/.test(src)) missing.push(`${rel}（${label}）`);
  }
  assert.deepStrictEqual(
    missing,
    [],
    `以下节点没有请求订阅授权，业主会收不到通知：\n  ${missing.join('\n  ')}`,
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
