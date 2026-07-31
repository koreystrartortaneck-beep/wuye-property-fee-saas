const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 支付确认页的资金显示守卫。
 *
 * 起因（后端改了前端没跟上）：后端 consumeCouponInTx 已拒绝把应付降到 0
 * （微信不接受 0 元订单，那个错误会让订单卡进 PREPAY_UNKNOWN、账单被占用、券被消耗），
 * 但 pay-confirm 的 recalc 仍允许 payAmount = 0，界面照样显示「确认支付 ¥0.00」
 * 并让业主点下去，点了才被后端拒。
 *
 * 业主看到的金额与可选项，必须与后端实际接受的一致。
 */
const MP = path.join(__dirname, '..', 'apps', 'miniprogram');
const PAY = path.join(MP, 'pages', 'pay-confirm', 'pay-confirm.js');

test('支付确认页不得显示 0 元实付（后端会拒，业主点了才知道）', () => {
  const src = fs.readFileSync(PAY, 'utf8');
  // recalc 必须显式处理「实付非正」的情况
  assert.match(src, /payAmount\s*<=\s*0|payAmount\s*<\s*=\s*0/, 'recalc 必须挡住实付非正的情况');
  // 选券时就要提示，而不是等提交被拒
  assert.match(src, /已覆盖本单全部金额/, '选到覆盖全额的券时必须当场说清原因');
});

test('支付提交仍有防连点守卫', () => {
  const src = fs.readFileSync(PAY, 'utf8');
  assert.match(src, /if \(this\.data\.paying\) return/, '支付提交必须防连点，否则可能重复下单');
});

test('金额展示取自后端复核结果，不信任本地缓存', () => {
  const src = fs.readFileSync(PAY, 'utf8');
  // quote 接口是权威金额来源
  assert.match(src, /payments\/quote|quote\//, '确认页必须向后端复核账单金额');
});
