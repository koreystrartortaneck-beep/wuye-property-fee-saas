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

// ───────────────────── ③ 放弃时的文案必须安抚 ─────────────────────

test('③ 等不到时的提示要说「钱已收到」和「不要重复支付」', () => {
  /*
   * 这一条是纯文案，但它是事故里伤害最大的部分：
   * 业主看到「请稍后查看」时，合理的推断是钱丢了 —— 于是会再付一次。
   * 必须明确三件事：已扣款成功 / 正在核对 / 不要重复支付 / 去哪儿查。
   */
  const src = fs.readFileSync(path.join(MP, 'pages/pay-confirm/pay-confirm.js'), 'utf8');

  const required = [
    ['已收到', '没有告知「钱已收到」'],
    ['不要重复支付', '没有劝阻重复支付——业主最可能做的就是再付一次'],
    ['缴费记录', '没有指明去哪里自查'],
  ];
  for (const [needle, why] of required) {
    assert.ok(src.includes(needle), why);
  }

  // 反向：不能再出现「支付未完成 / 支付失败」这类把已扣款说成没成功的措辞
  for (const bad of ['支付未完成', '支付失败，请重新']) {
    assert.ok(!src.includes(bad), `文案里仍有误导性措辞：${bad}`);
  }
});

test('③ 兜底提示只在真的没等到时出现，不能盖住成功路径', () => {
  const src = stripComments(fs.readFileSync(path.join(MP, 'pages/pay-confirm/pay-confirm.js'), 'utf8'));
  const idx = src.indexOf('已收到');
  assert.ok(idx > 0);
  /*
   * 该提示必须在「确认成功」的分支之后 —— 也就是它是走完查单窗口仍未成功时的兜底。
   * 若它出现在 SUCCESS 判断之前，正常缴费的人也会看到这个弹窗。
   */
  const successIdx = src.indexOf("'SUCCESS'");
  assert.ok(successIdx > 0, '找不到 SUCCESS 判断');
  assert.ok(idx > successIdx, '安抚提示出现在 SUCCESS 判断之前，会误伤正常缴费的业主');
});
