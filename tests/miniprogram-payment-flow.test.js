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

test('账单页每张账单独立缴费、去除多选合并', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'apps/miniprogram/pages/bill/bill.js'),
    'utf8',
  );
  // 单账单支付：提供逐张缴费动作
  assert.match(source, /payBill/);
  // 去除多选合并支付的所有行为
  assert.doesNotMatch(source, /selectedIds/);
  assert.doesNotMatch(source, /toggleSelect/);
  assert.doesNotMatch(source, /pendingBills/);

  const wxml = fs.readFileSync(
    path.join(projectRoot, 'apps/miniprogram/pages/bill/bill.wxml'),
    'utf8',
  );
  assert.doesNotMatch(wxml, /toggleSelect/);
  assert.doesNotMatch(wxml, /check-circle/);
});

test('确认页按单账单契约下单并向后端复核金额与收款状态', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'apps/miniprogram/pages/pay-confirm/pay-confirm.js'),
    'utf8',
  );
  // 单账单契约：billId + requestId，且不再发送 billIds 数组
  assert.match(source, /billId/);
  assert.match(source, /requestId/);
  assert.doesNotMatch(source, /billIds/);
  // 向后端复核（quote）账单金额与分层收款状态，不再信任本地缓存汇总
  assert.match(source, /\/owner\/payments\/quote/);
  assert.doesNotMatch(source, /pendingBills/);
});

const invoiceUtils = require(path.join(projectRoot, 'apps/miniprogram/utils/invoice.js'));

test('仅支付成功且未退款的订单可申请开票', () => {
  assert.equal(invoiceUtils.canApplyInvoice({ status: 'SUCCESS' }), true);
  assert.equal(invoiceUtils.canApplyInvoice({ status: 'REFUNDED' }), false);
  assert.equal(invoiceUtils.canApplyInvoice({ status: 'CREATED' }), false);
  assert.equal(invoiceUtils.canApplyInvoice({ status: 'FAILED' }), false);
  assert.equal(invoiceUtils.canApplyInvoice(null), false);
});

test('开票载荷按契约构造：抬头/税号/交付方式/幂等键', () => {
  const p = invoiceUtils.buildInvoicePayload({
    orderNo: 'WY9',
    titleType: 'PERSONAL',
    title: '张三',
    deliveryMethod: 'EMAIL',
    email: 'a@b.com',
    requestId: 'inv-fixed',
  });
  assert.equal(p.orderNo, 'WY9');
  assert.equal(p.title, '张三');
  assert.equal(p.titleType, 'PERSONAL');
  assert.equal(p.deliveryMethod, 'EMAIL');
  assert.equal(p.email, 'a@b.com');
  assert.equal(p.requestId, 'inv-fixed');
  // 个人抬头不带税号
  assert.equal('taxNo' in p, false);

  const ent = invoiceUtils.buildInvoicePayload({
    orderNo: 'WY9',
    titleType: 'ENTERPRISE',
    title: '某某公司',
    taxNo: '91310000MA1',
    deliveryMethod: 'EMAIL',
    requestId: 'inv-fixed',
  });
  assert.equal(ent.taxNo, '91310000MA1');

  // 抬头必填；企业抬头必须带税号
  assert.throws(() => invoiceUtils.buildInvoicePayload({ orderNo: 'WY9', title: ' ', deliveryMethod: 'EMAIL' }));
  assert.throws(() =>
    invoiceUtils.buildInvoicePayload({ orderNo: 'WY9', titleType: 'ENTERPRISE', title: '公司', taxNo: '', deliveryMethod: 'EMAIL' }),
  );
  // 未提供 requestId 时自动生成稳定幂等键
  const auto = invoiceUtils.buildInvoicePayload({ orderNo: 'WY9', title: '张三', deliveryMethod: 'EMAIL' });
  assert.match(auto.requestId, /^inv-/);
});

test('缴费记录页区分退款状态且已退款订单不可开票、可开票订单跳开票页', () => {
  const js = fs.readFileSync(path.join(projectRoot, 'apps/miniprogram/pages/payments/payments.js'), 'utf8');
  // 退款状态标签
  assert.match(js, /REFUNDED/);
  // 依据 canApplyInvoice 判断开票资格，跳转开票申请页
  assert.match(js, /canApplyInvoice/);
  assert.match(js, /invoice-apply/);
});

test('缴费成功页提供申请开票入口', () => {
  const wxml = fs.readFileSync(path.join(projectRoot, 'apps/miniprogram/pages/pay-success/pay-success.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(projectRoot, 'apps/miniprogram/pages/pay-success/pay-success.js'), 'utf8');
  assert.match(js, /invoice-apply/);
  assert.match(wxml, /开票|发票/);
});

test('开票申请页与开票记录页均已注册且开票页拒绝非成功订单', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'apps/miniprogram/app.json'), 'utf8'));
  assert.ok(appJson.pages.includes('pages/invoice-apply/invoice-apply'));
  assert.ok(appJson.pages.includes('pages/invoices/invoices'));
  const applyJs = fs.readFileSync(path.join(projectRoot, 'apps/miniprogram/pages/invoice-apply/invoice-apply.js'), 'utf8');
  // 提交前用 canApplyInvoice 守卫，且按契约调用 owner/invoices
  assert.match(applyJs, /canApplyInvoice/);
  assert.match(applyJs, /\/owner\/invoices/);
});

test('首页依据后端分层收款状态展示暂停提示', () => {
  const js = fs.readFileSync(path.join(projectRoot, 'apps/miniprogram/pages/index/index.js'), 'utf8');
  // 借助报价接口复核收款是否暂停，状态由后端派生
  assert.match(js, /collectionPaused/);
  assert.match(js, /PAUSED/);
  assert.match(js, /\/owner\/payments\/quote/);
  const wxml = fs.readFileSync(path.join(projectRoot, 'apps/miniprogram/pages/index/index.wxml'), 'utf8');
  assert.match(wxml, /collectionPaused/);
});

test('订阅被拒绝时降级处理不抛错', () => {
  const subscribe = require(path.join(projectRoot, 'apps/miniprogram/utils/subscribe.js'));
  const r = subscribe.summarizeSubscribeResult(['A', 'B'], { A: 'reject', B: 'reject' });
  assert.equal(r.accepted, false);
  assert.equal(r.denied, true);
  const r2 = subscribe.summarizeSubscribeResult(['A', 'B'], { A: 'accept', B: 'reject' });
  assert.equal(r2.accepted, true);
});
