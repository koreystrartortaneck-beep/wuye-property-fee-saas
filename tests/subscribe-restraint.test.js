const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 订阅授权弹窗必须克制。
 *
 * 业主的原话：「为什么现在随便点击一个按钮都要出现订阅一次消息通知？」
 *
 * 我把 accrueSubscribeQuota() 挂到了三个纯跳转的地方 ——
 * 点账单卡片（全小程序最高频的点击）、首页主按钮、缴费成功页的「返回首页」。
 * 理由是「业主若勾过『总是保持以上选择，不再询问』，调用就静默通过，
 * 可以无感累积额度」。
 *
 * 这个赌注下错了：**大多数业主并没有勾过那个选项**。于是点每一张账单弹一次框。
 * 而反复弹、反复被关掉，只会把人训练成条件反射点「取消」，最后落到 reject/ban ——
 * 比从不打扰更糟，因为那之后连真正该发的提醒也发不出去了。
 * 而额度本身是投机性的：真正要发的（出账、到期、逾期）一个月才几条。
 *
 * 规则：只在**与提醒本身相关**的时刻问。
 *   · 缴费时（提醒讲的就是账单）—— 且 7 天内最多一次
 *   · 「我的 → 开启缴费提醒」（业主自己点的开关）—— 每次都问，那是他要的
 *   · 其它一概不问，尤其是纯跳转
 */

const MP = path.join(__dirname, '..', 'apps/miniprogram');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 遍历所有页面的 js */
function pageFiles() {
  const dir = path.join(MP, 'pages');
  const out = [];
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, `${d}.js`);
    if (fs.existsSync(f)) out.push([`pages/${d}/${d}.js`, fs.readFileSync(f, 'utf8')]);
  }
  return out;
}

test('只有两个地方可以请求订阅授权', () => {
  /*
   * 白名单式断言。新增一个调用点就会红 —— 那时应该先问「这个时刻和提醒有关吗」，
   * 而不是顺手加进白名单。
   */
  const ALLOWED = new Set(['pages/pay-confirm/pay-confirm.js', 'pages/mine/mine.js']);
  const callers = [];
  for (const [name, raw] of pageFiles()) {
    const src = stripComments(raw);
    if (/\b(requestSubscribe|maybeRequestSubscribe)\s*\(/.test(src)) callers.push(name);
  }
  assert.ok(callers.length > 0, '扫描器坏了：一个调用点都没找到');
  const extra = callers.filter((c) => !ALLOWED.has(c));
  assert.deepStrictEqual(extra, [], `这些地方不该请求订阅授权：\n  ${extra.join('\n  ')}`);
});

test('那个「顺带累积额度」的函数已经删掉，不留后路', () => {
  /*
   * 只要它还导出着，下一个人（或下一个我）就会觉得「顺手挂一下没关系」。
   * 注释里可以提它（记录为什么删），但不能有可调用的实现。
   */
  const src = stripComments(read('utils/subscribe.js'));
  assert.ok(!src.includes('accrueSubscribeQuota'), 'accrueSubscribeQuota 仍然存在');
});

test('纯跳转的处理函数里不许有订阅请求', () => {
  /*
   * 上一条是白名单，这一条是正向语义：即使在白名单文件里，
   * 也不能挂在只做 navigateTo / switchTab 的函数上。
   */
  for (const [name, raw] of pageFiles()) {
    const src = stripComments(raw);
    // 逐个函数体检查（真括号匹配，定长切片会切进下一个函数）
    const re = /\n {2}(?:async )?(\w+)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      let depth = 0;
      let body = '';
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            body = src.slice(open + 1, i);
            break;
          }
        }
      }
      if (!/\b(requestSubscribe|maybeRequestSubscribe)\s*\(/.test(body)) continue;
      const navOnly =
        /wx\.(navigateTo|switchTab|redirectTo|navigateBack)/.test(body) &&
        !/requestPayment|payments|enableNotify/.test(body);
      assert.ok(
        !navOnly,
        `${name} 的 ${m[1]}() 只是跳转，却请求了订阅授权`,
      );
    }
  }
});

test('缴费路径上用的是节流版，不是每次都问', () => {
  const src = stripComments(read('pages/pay-confirm/pay-confirm.js'));
  assert.ok(src.includes('maybeRequestSubscribe'), '缴费页没有用节流版');
  assert.ok(
    !/\brequestSubscribe\s*\(/.test(src),
    '缴费页仍在用无节流的 requestSubscribe —— 每次缴费都会弹',
  );
});

test('业主自己点的开关每次都问——那是他要的', () => {
  /*
   * 反向保护：别把节流用错地方。业主主动点「开启缴费提醒」时，
   * 如果因为 7 天内问过而静默跳过，他会以为按钮坏了。
   */
  const src = stripComments(read('pages/mine/mine.js'));
  const i = src.indexOf('async enableNotify');
  assert.ok(i > 0, '找不到 enableNotify');
  const body = src.slice(i, src.indexOf('\n  },', i));
  assert.ok(body.includes('requestSubscribe'), 'enableNotify 里没有请求授权');
  assert.ok(
    !body.includes('maybeRequestSubscribe'),
    'enableNotify 用了节流版：业主主动点却被静默跳过，他会以为按钮坏了',
  );
});

test('节流的判据只读同步存储——异步读会丢掉点击手势上下文', () => {
  /*
   * wx.requestSubscribeMessage 必须在点击手势的上下文里同步发起。
   * 若先 await 一次 wx.getSetting 再调，手势上下文已经丢了，弹窗根本弹不出来 ——
   * 而表现是「点了没反应」，非常难查。所以判据只能来自同步的本地存储。
   */
  const src = stripComments(read('utils/subscribe.js'));
  const i = src.indexOf('function maybeRequestSubscribe');
  assert.ok(i > 0, '找不到 maybeRequestSubscribe');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.ok(!body.includes('getSetting'), '节流判据里调了异步的 getSetting');
  assert.ok(!/await/.test(body.split('new Promise')[0]), '发起弹窗之前有 await，手势上下文会丢');
  assert.ok(body.includes('readAskRecord'), '没有读本地记录，节流等于没有');
});

test('被微信禁用后不再骚扰，且拒绝过的人有冷却期', () => {
  const src = stripComments(read('utils/subscribe.js'));
  const i = src.indexOf('function maybeRequestSubscribe');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.match(body, /state === 'ban'/, 'ban 之后仍会尝试弹窗（弹也弹不出来）');
  assert.match(body, /ASK_GAP_MS/, '没有冷却期');

  // 冷却期要够长：1 天太短，等于每天问一次
  const gap = /ASK_GAP_MS\s*=\s*([^;]+);/.exec(src);
  assert.ok(gap, '找不到 ASK_GAP_MS');
  // eslint-disable-next-line no-eval
  const ms = eval(gap[1]);
  assert.ok(ms >= 3 * 24 * 3600 * 1000, `冷却期只有 ${ms / 86400000} 天，太短`);

  // accept 状态要例外：那种调用对业主无感，不该被冷却挡住（否则白丢额度）
  assert.match(body, /state !== 'accept'/, 'accept 状态也被冷却挡住了，白丢额度');
});
