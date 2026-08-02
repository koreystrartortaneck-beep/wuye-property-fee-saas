const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 提交绑定申请之后不能进黑洞。
 *
 * 排查「业主从打开小程序到缴费的完整流程」时发现的：
 *
 * /owner/my/houses 只返回 **ACTIVE** 绑定，所以「从没申请过」和「已申请、等审核」
 * 落到同一个分支 —— 首页对两者都说「首次使用请先绑定您的房屋」并给一个
 * 「立即绑定」按钮。已经申请过的人看不到任何痕迹，会合理地认为申请丢了，
 * 于是再申请一次，然后撞上后端 (wxUserId, houseId) 的唯一约束，
 * 得到一句「已存在绑定」的错误 —— 对一个完全合理的动作报错。
 *
 * 而审核通过也**没有任何通知**（NotifyType 只有 BILL_CREATED / DUE_SOON / OVERDUE），
 * 业主只能反复打开小程序碰运气。被驳回同样：他不知道为什么，也不知道能不能再来。
 *
 * 所以首页必须把三种情形分开。这是新业主的第一屏，也是整个流程最容易卡住的一步。
 */

const MP = path.join(__dirname, '..', 'apps/miniprogram');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
// 读 WXML 一律先剥注释：注释里写着和代码一样的关键词，会让断言在注释上通过
const readWxml = (p) => read(p).replace(/<!--[\s\S]*?-->/g, '');

test('首页区分「从没申请过 / 审核中 / 被驳回」三种情形', () => {
  const wxml = readWxml('pages/index/index.wxml');
  assert.match(wxml, /pendingBinding && !pendingBinding\.rejected/, '没有「审核中」分支');
  assert.match(wxml, /pendingBinding && pendingBinding\.rejected/, '没有「被驳回」分支');
  assert.match(wxml, /首次使用请先绑定/, '「从没申请过」的引导丢了');
  // 三者必须互斥
  assert.match(wxml, /wx:elif=/, '三个分支没有用 if/elif/else 串起来');
});

test('审核中不给「立即绑定」——再点一次只会撞唯一约束报错', () => {
  const wxml = readWxml('pages/index/index.wxml');
  const i = wxml.indexOf('审核中');
  assert.ok(i > 0);
  // 取「审核中」分支到下一个 block 之间
  const branch = wxml.slice(i, wxml.indexOf('wx:elif', i));
  assert.ok(!/bindtap="goBind"/.test(branch), '审核中仍然给了绑定按钮');
  assert.match(branch, /物业审核通过后/, '没有告诉业主接下来会发生什么');
});

test('被驳回要说明原因，并允许重新申请', () => {
  /*
   * 不说原因，业主既不知道该改什么，也不知道能不能再来一次。
   * 物业没填原因时也要给一句能行动的话，而不是留空。
   */
  const wxml = readWxml('pages/index/index.wxml');
  const i = wxml.indexOf('未通过');
  assert.ok(i > 0, '没有「未通过」分支');
  const branch = wxml.slice(i, wxml.indexOf('wx:else>', i));
  assert.match(branch, /pendingBinding\.reason/, '没有显示驳回原因');
  assert.match(branch, /联系物业/, '物业没填原因时没有兜底提示');
  assert.match(branch, /重新申请/, '被驳回后没有再来一次的入口');
});

test('申请状态从后端取，且读不到时退回原引导', () => {
  const js = read('pages/index/index.js');
  assert.match(js, /request\('\/owner\/my\/bindings'/, '没有查申请状态');
  const i = js.indexOf("'/owner/my/bindings'");
  const around = js.slice(i - 200, i + 900);
  // PENDING 优先于 REJECTED：有在途申请时不该显示上一次的驳回
  assert.match(around, /status === 'PENDING'/, '没有优先取在途申请');
  assert.match(around, /status === 'REJECTED'/, '没有处理被驳回');
  assert.match(around, /catch/, '读不到申请状态时会把首页打挂');
  assert.match(around, /silent: true/, '这是后台补充信息，失败不该弹 toast');
});

test('拿到生效房屋后不再显示申请态', () => {
  /*
   * 审核通过后 myHouses 会返回房屋，走正常分支。
   * 若 pendingBinding 没被清掉，会出现「有账单 + 审核中」同框。
   */
  const js = read('pages/index/index.js');
  const i = js.indexOf('noHouse: false');
  assert.ok(i > 0);
  // 正常分支里 noHouse=false，模板对整块 noHouse 把门，所以申请态自然不显示
  const wxml = readWxml('pages/index/index.wxml');
  assert.match(wxml, /wx:if="\{\{ready && noHouse\}\}"/, '申请态没有被 noHouse 整体把门');
});
