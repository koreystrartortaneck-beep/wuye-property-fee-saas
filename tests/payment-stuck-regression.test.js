const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 2026-08-01「钱扣了，页面一直卡在确认支付结果」事故的回归守卫。
 *
 * 实际发生的事：两笔真实支付（¥1 / ¥2.5）微信已扣款成功，
 * 但小程序页面一直转圈，账单始终显示未缴，最后靠人工调 force-sync 才入账。
 *
 * 叠在一起的四个缺陷（缺任何一个都不至于这么难受）：
 *
 *   ① 小程序的 HTTP 请求没有超时。wx.request / callContainer 默认 60 秒，
 *      查单卡住时页面就是干等 —— 用户看到的「一直转圈」主要是这个。
 *   ② 查单窗口只有 5 秒（连查 5 次 × 1 秒）。微信入账通知晚几秒就等不到。
 *   ③ 放弃时的文案是「请稍后查看」，没有一个字说「钱已经收到了、别再付一次」。
 *      业主此刻最怕的是钱被吞，最可能做的是再付一次。
 *      （这一条后来连设计一起改了：支付成功立刻进成功页，不再有等待与弹框；
 *        「钱已收到 / 别再付」改由账单页的「入账中」状态承担，见文末。）
 *   ④ 后台的自动补救 10 分钟一轮、且只处理创建满 30 分钟的订单 = 最坏 40 分钟。
 *      （④ 由 apps/api 侧的 payment-recovery.service.spec.ts 钉住。）
 *
 * 这个文件钉 ①②③ —— 它们都在小程序端，没有任何单元测试覆盖，
 * 而三者都是「改一个常量就静默退回去」的形状。
 */

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'apps/miniprogram');
const paymentUtils = require(path.join(MP, 'utils/payment.js'));

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ───────────────────────── ① 请求必须有超时 ─────────────────────────

test('① 两个请求分支都设了超时——没有超时时「转圈」就是 60 秒起', () => {
  const src = stripComments(fs.readFileSync(path.join(MP, 'utils/request.js'), 'utf8'));

  /*
   * 必须两个分支都设。request.js 里有两条路径：
   * 微信云托管走 wx.cloud.callContainer，普通域名走 wx.request。
   * 只给一条加超时最容易漏 —— 真机跑的恰恰是 callContainer 那条。
   *
   * 切片必须**在两个分支之间断开**：第一版写的是 slice(indexOf(...)) 一直到文件末尾，
   * 于是删掉 callContainer 的 timeout 之后，断言仍然命中了 wx.request 分支里的那个，
   * 测试照样全绿 —— 正是这条守卫要防的漏法，被自己的切片放过去了。
   */
  const iCall = src.indexOf('wx.cloud.callContainer');
  const iReq = src.lastIndexOf('wx.request(');
  assert.ok(iCall > 0 && iReq > iCall, '两个请求分支的相对位置与预期不符，切片会失效');
  const branches = [
    ['wx.cloud.callContainer', src.slice(iCall, iReq)],
    ['wx.request', src.slice(iReq)],
  ];
  for (const [name, body] of branches) {
    assert.match(body, /timeout:/, `${name} 分支没有 timeout`);
  }

  // 超时值本身要落在合理区间：太短会误杀慢网络，太长等于没设
  const m = /TIMEOUT_MS\s*=\s*(\d+)/.exec(src);
  assert.ok(m, '超时值应提为具名常量，便于一处调整');
  const ms = Number(m[1]);
  assert.ok(ms >= 8000 && ms <= 20000, `超时 ${ms}ms 不在 8~20 秒的合理区间`);
});

// ───────────────────── ② 查单窗口必须够长且退避 ─────────────────────

test('② 默认查单窗口不少于 15 秒（原来只有 5 秒，微信晚几秒就等不到）', async () => {
  const waits = [];
  let queries = 0;
  await paymentUtils.waitForPaymentConfirmation('WY-stuck', {
    requestFn: async () => {
      queries += 1;
      return { orderNo: 'WY-stuck', status: 'CREATED' }; // 始终未入账，走满全程
    },
    sleepFn: async (ms) => {
      waits.push(ms);
    },
  });

  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total >= 15000, `总等待只有 ${total}ms，不足 15 秒`);
  assert.ok(queries >= 6, `只查了 ${queries} 次`);
  // 查询次数必须比间隔数多 1：最后一次间隔后还要再查一次，否则白等
  assert.equal(queries, waits.length + 1, '最后一段等待后没有再查一次');
});

test('② 间隔是递增退避，不是一路 5 秒——前几秒最可能成功，要多试', async () => {
  const waits = [];
  await paymentUtils.waitForPaymentConfirmation('WY-stuck', {
    requestFn: async () => ({ status: 'CREATED' }),
    sleepFn: async (ms) => {
      waits.push(ms);
    },
  });

  assert.ok(waits[0] <= 1500, `首个间隔 ${waits[0]}ms 太长，第一次复查该来得快`);
  assert.ok(waits[waits.length - 1] >= waits[0], '间隔应递增或持平，不应越查越急');
  // 窗口前 5 秒内至少查 3 次
  let acc = 0;
  let earlyQueries = 1;
  for (const w of waits) {
    acc += w;
    if (acc <= 5000) earlyQueries += 1;
  }
  assert.ok(earlyQueries >= 3, `前 5 秒只查了 ${earlyQueries} 次`);
});

test('② 拉长窗口不能把终态也拖着——CLOSED / FAILED 立即抛出', async () => {
  /*
   * 这是拉长窗口的风险面：订单已经明确失败时，
   * 若还按 20 秒的窗口重试，业主要对着转圈等 20 秒才被告知失败。
   */
  const waits = [];
  await assert.rejects(
    paymentUtils.waitForPaymentConfirmation('WY-closed', {
      requestFn: async () => ({ status: 'CLOSED' }),
      sleepFn: async (ms) => waits.push(ms),
    }),
    /关闭/,
  );
  assert.equal(waits.length, 0, '终态不该等待任何间隔');
});

test('② 成功后立刻返回，不跑完剩下的间隔', async () => {
  const waits = [];
  const r = await paymentUtils.waitForPaymentConfirmation('WY-ok', {
    requestFn: async () => ({ orderNo: 'WY-ok', status: 'SUCCESS' }),
    sleepFn: async (ms) => waits.push(ms),
  });
  assert.equal(r.status, 'SUCCESS');
  assert.equal(waits.length, 0);
});

// ───────────── ③ 「钱已收到、别再付」必须说到，但落点已经变了 ─────────────

/*
 * 原来这两条钉的是 pay-confirm 里那个「已收到您的支付…请不要重复支付」的弹框。
 *
 * 重新设计之后那个弹框不该存在了：业主付完款就该看到「缴费成功」，
 * 而不是先被一个解释性弹框拦住 ——「支付成功后要及时反馈」是产品要求，
 * 而原设计为了等我们自己记账，把这个反馈往后压了几十秒到几十分钟。
 *
 * 但那个弹框要传达的两件事一件都不能少，只是换了落点，
 * 从「支付后弹框」变成「账单页的状态」：
 *   · 钱已经收到了    → 账单显示「入账中」+「微信已扣款，正在入账」
 *   · 请不要重复支付  → 详情页收起缴费按钮 + 明写「请勿重复支付」
 * 落点变了守卫要跟着变，但不能因为「弹框没了」就把守卫删掉。
 */

test('③ 账单页要告诉业主钱已收到，而不是显示「待缴」', () => {
  const js = fs.readFileSync(path.join(MP, 'pages/bill/bill.js'), 'utf8');
  assert.ok(js.includes('入账中'), '账单列表仍把已付款的账单显示成「待缴」');
  assert.ok(js.includes('微信已扣款'), '没有告知业主钱已经收到');
});

test('③ 详情页要劝阻重复支付，并且真的不给按钮', () => {
  const js = fs.readFileSync(path.join(MP, 'pages/bill-detail/bill-detail.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(MP, 'pages/bill-detail/bill-detail.wxml'), 'utf8');
  assert.ok(wxml.includes('请勿重复支付'), '没有劝阻重复支付——业主最可能做的就是再付一次');
  /*
   * 只写一句提示不够：按钮还在，他照样能点。
   * 「说了别做」和「做不了」必须同时成立。
   */
  assert.match(
    wxml,
    /wx:if="\{\{bill\.status === 'UNPAID' && !bill\.settling\}\}"/,
    '入账中仍然给出缴费按钮',
  );
  assert.match(js, /b\.status !== 'UNPAID' \|\| b\.settling/, 'goPay 没有二次拦截');
});

test('③ 支付成功路径上不再有解释性弹框——业主要的只是「缴清了」', () => {
  const src = stripComments(fs.readFileSync(path.join(MP, 'pages/pay-confirm/pay-confirm.js'), 'utf8'));
  const start = src.indexOf('wx.requestPayment');
  const branchEnd = src.indexOf('} else {', start);
  assert.ok(start > 0 && branchEnd > start, '找不到 requestPayment 分支');
  const branch = src.slice(start, branchEnd);
  assert.ok(!branch.includes('showModal'), '支付成功路径上仍有弹框');
  assert.ok(!branch.includes('showLoading'), '支付成功路径上仍有阻塞式 loading');
});
