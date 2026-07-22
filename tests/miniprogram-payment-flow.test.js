const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const paymentUtils = require(path.join(projectRoot, 'apps/miniprogram/utils/payment.js'));

test('真实支付后通过后端查单确认 SUCCESS', async () => {
  const statuses = ['CREATED', 'SUCCESS'];
  const calls = [];
  const result = await paymentUtils.waitForPaymentConfirmation('WY1', {
    attempts: 3,
    intervalMs: 0,
    requestFn: async (url, options) => {
      calls.push({ url, options });
      return { orderNo: 'WY1', status: statuses.shift() };
    },
    sleepFn: async () => {},
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/owner/payments/WY1/sync');
});

test('查单的瞬时网络失败不会中断后续确认', async () => {
  let attempts = 0;
  const result = await paymentUtils.waitForPaymentConfirmation('WY2', {
    attempts: 2,
    intervalMs: 0,
    requestFn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary network error');
      return { orderNo: 'WY2', status: 'SUCCESS' };
    },
    sleepFn: async () => {},
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(attempts, 2);
});

test('未确认成功时不进入缴费成功页', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'apps/miniprogram/pages/pay-confirm/pay-confirm.js'),
    'utf8',
  );
  assert.match(source, /waitForPaymentConfirmation/);
  assert.match(source, /confirmed\.status !== 'SUCCESS'/);
});
