const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 手机号是可选的，但「未绑定」这件事必须可行动。
 *
 * 业主的疑问：「为什么我的微信号显示没有绑定手机号，但是也能用这个小程序？」
 *
 * 系统的设计是对的，三样东西分开：
 *   · 你是谁    → 微信 openid（wx.login）
 *   · 你能看/缴哪户 → 房屋绑定（HouseBinding 为 ACTIVE）
 *   · 手机号    → 只用来自动匹配房屋（House.ownerPhone 命中即自动建绑定）
 * 所以走「自助申请 + 物业审核」这条路的业主不绑手机号也能正常缴费。
 *
 * 但这一问暴露了两个真问题：
 *
 * ① 「我的」页那行「未绑定手机号」原本是个**不可点的 view**，
 *    而唯一的绑定入口在「绑定房屋」页 —— 已经绑好房屋的人不会再进那个页面。
 *    于是这句话看起来像个待办，却既没解释也没出口。
 *
 * ② 更实质：物业联系不到业主。工单详情、房屋档案、绑定审核三处都展示业主手机号，
 *    物业靠它联系人，而业主可以完全不提供 —— 报修之后物业想打电话确认都做不到，
 *    而业主并不知道这件事。所以未绑定时必须把「绑了有什么用」讲出来。
 */

const MP = path.join(__dirname, '..', 'apps/miniprogram');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
/*
 * 读 WXML 一律剥掉 HTML 注释。
 *
 * 今天已经在这个坑上栽了三次（「已实时入账」「confirmDeleteAccount」，加这次）：
 * 注释里往往写着和代码里一模一样的关键词（因为注释就是在解释那段代码），
 * indexOf 先命中注释，于是断言检查的是一段说明文字。
 * 它的坏处不是测试失败，而是**测试可能因此通过** —— 注释里有那句话就够了。
 */
const readWxml = (p) => read(p).replace(/<!--[\s\S]*?-->/g, '');

test('未绑定时那一行是可点的，不是一句干巴巴的状态', () => {
  const wxml = readWxml('pages/mine/mine.wxml');
  const i = wxml.indexOf('未绑定手机号');
  assert.ok(i > 0, '找不到未绑定文案');
  /*
   * 必须是 button open-type="getPhoneNumber"：微信的手机号授权只能由它触发，
   * 普通 view + bindtap 拿不到 code。这不是风格问题，是能不能用的问题。
   */
  const block = wxml.slice(Math.max(0, i - 400), i + 200);
  assert.match(block, /open-type="getPhoneNumber"/, '未绑定行不是手机号授权按钮');
  assert.match(block, /bindgetphonenumber="onGetPhone"/, '没有接授权回调');
});

test('未绑定时要讲清「绑了有什么用」', () => {
  /*
   * 只说「未绑定」是制造焦虑。业主需要知道的是代价：
   * 不绑，物业就联系不到他 —— 而报修之后物业往往需要打电话确认。
   */
  const wxml = readWxml('pages/mine/mine.wxml');
  assert.match(wxml, /物业可电话联系您/, '没有说明不绑的代价');
  assert.match(wxml, /自动匹配名下房屋/, '没有说明绑定的好处');
});

test('已绑定时只显示掩码手机号，不再出现绑定入口', () => {
  const wxml = readWxml('pages/mine/mine.wxml');
  assert.match(wxml, /wx:if="\{\{hasPhone\}\}"[\s\S]{0,120}profile-phone/, '已绑定分支不对');
  // 未绑定分支必须由 wx:else 把着，否则两种状态会同时出现
  const i = wxml.indexOf('未绑定手机号');
  assert.match(wxml.slice(Math.max(0, i - 300), i), /wx:else/, '未绑定行没有被 wx:else 把门');
  /*
   * 真机与 mock 两条分支都要有，且必须互斥：
   * 真机走 open-type，mock 没有这个能力、退回绑定房屋页手动输入。
   */
  assert.match(wxml, /wx:if="\{\{!mockAuth\}\}"/, '缺少真机/mock 分支');
});

test('hasPhone 来自后端真实值，不是靠文案反推', () => {
  /*
   * 曾经的写法是把「未绑定手机号」这句话直接塞进 phone 字段，
   * 模板再去比字符串。那样一改文案就全坏，而且没人会想到是这个原因。
   */
  const js = read('pages/mine/mine.js');
  assert.match(js, /hasPhone:\s*!!me\.phone/, 'hasPhone 不是从后端字段派生');
});

test('授权按钮的默认外观被清掉——深色卡片上不能冒出白方块', () => {
  /*
   * 小程序 button 自带白底、圆角、1px 边框（含 ::after 那圈）和 min-width。
   * 不清掉的话，深色档案卡上会突兀地出现一个白色方块。
   * 这一条是渲染截图后加的：只读代码看不出来。
   */
  const wxss = read('pages/mine/mine.wxss');
  const i = wxss.indexOf('.phone-bind-btn');
  assert.ok(i > 0, '缺少 .phone-bind-btn 样式');
  const rule = wxss.slice(i, wxss.indexOf('}', i));
  assert.match(rule, /background:\s*transparent/, '没有清掉白底');
  assert.match(rule, /border:\s*none/, '没有清掉边框');
  assert.ok(wxss.includes('.phone-bind-btn::after'), '没有清掉 ::after 的那圈边框');
});

test('用户点了取消不当作失败，但要说清放弃了什么', () => {
  const js = read('pages/mine/mine.js');
  const i = js.indexOf('async onGetPhone');
  const body = js.slice(i, js.indexOf('\n  },', i));
  assert.match(body, /if \(!code\)/, '没有处理用户取消');
  assert.match(body, /无法电话联系/, '取消时没有说清代价');
  assert.ok(!/showModal/.test(body), '取消是正常选择，不该用弹框拦人');
});

test('绑定成功后刷新本页——否则那一行还停在「未绑定」', () => {
  const js = read('pages/mine/mine.js');
  const i = js.indexOf('async onGetPhone');
  const body = js.slice(i, js.indexOf('\n  },', i));
  assert.match(body, /await this\.onShow\(\)/, '绑定成功后没有重新加载档案');
  // 顺带匹配到房屋是意外之喜，要说出来
  assert.match(body, /matchedHouses/, '没有告知自动匹配到了几处房屋');
});

/*
 * ── 手机号绑上了但没匹配到房屋 —— 不能说成失败 ──
 *
 * 2026-08-01 实测撞到的：业主授权了手机号，而物业没在房屋档案里登记这个号码，
 * 于是 matchedHouses = 0，页面弹出「未匹配到登记房屋，请在下方申请绑定」。
 *
 * 两处不对：
 *   · 手机号**已经绑上了**（物业从此能联系到他），这句话让人以为整件事失败了
 *   · 对已经有房屋的业主，让他去「申请绑定」他已经绑好的房，更莫名其妙
 *
 * 同一类问题：动作成功了，提示却让人以为失败。
 */

function afterBindBody() {
  const src = read('pages/bind-house/bind-house.js').replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /\n  (?:async )?afterBind\s*\(/.exec(src);
  assert.ok(m, '找不到 afterBind');
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('括号不配对');
}

test('绑定手机号后先肯定「手机号已绑定」这件已完成的事', () => {
  const body = afterBindBody();
  assert.match(body, /手机号已绑定/, '没有肯定已完成的动作');
  assert.ok(
    !/未匹配到登记房屋，请在下方申请绑定/.test(body),
    '仍在用那句把成功说成失败的文案',
  );
});

test('已有房屋的业主不该被叫去「申请绑定」他已经绑好的房', () => {
  assert.match(afterBindBody(), /houses\.length > 0/, '没有按有没有房屋分开处理');
});

test('没有房屋时才引导去自助申请，并说清为什么没匹配上', () => {
  /*
   * 「没匹配上」的真实原因是物业没在房屋档案里登记这个号码 ——
   * 不说清楚的话，业主会反复去点那个授权按钮。
   */
  const body = afterBindBody();
  assert.match(body, /物业登记的业主手机号里没有这个号码/, '没有解释为什么没匹配上');
  assert.match(body, /自助申请绑定/, '没有指向下一步');
});
