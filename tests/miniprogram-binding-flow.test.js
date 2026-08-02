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

/*
 * ── 管理员打的字不能当成 App 自己在说话 ──
 *
 * 2026-08-02 实测：管理员（就是我）在解除原因里写了一句内部备注
 * 「业主体验全流程，临时解除，稍后重新申请」，业主端首页把它当成正式说明原样摆着，
 * 读起来像是系统在自言自语。物业的人同样会写出「测试」「先解了再说」这种话。
 *
 * 两层防护：
 *   · 业主端：原因必须**署名引用**，让业主知道那是物业写的、该找谁问
 *   · 后台：改成预置项 + 「其他」，并把业主会看到的原话直接预览出来
 *     （「业主可见」四个字提醒不了任何人，看到自己写的东西长什么样才会）
 */

test('业主端把解除原因标成「物业填写的」，不是 App 在说话', () => {
  const wxml = readWxml('pages/index/index.wxml');
  assert.match(wxml, /物业填写的原因：/, '原因没有署名，读起来像系统自己在说');
  // 系统自己的那句话要独立存在，不能被原因取代
  assert.match(wxml, /该房屋的绑定已被物业解除。/, '缺少系统侧的说明');
  assert.match(wxml, /物业未填写原因/, '物业没填时没有兜底');
});

test('重新申请必须清掉上一轮的结论', () => {
  /*
   * 只清 rejectReason 不够：revokedAt 决定业主端显示「已解除」还是「申请未通过」。
   * 留着它的话，这次申请若被驳回，首页会说「房屋绑定已解除」——
   * 而他这次根本没绑上过。
   */
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps/api/src/owner/owner-houses.controller.ts'),
    'utf8',
  );
  const i = src.indexOf('async applyBinding');
  const body = src.slice(i, src.indexOf('\n  }', src.indexOf('try {', i)));
  for (const f of ['rejectReason: null', 'revokedAt: null', 'revokeReason: null']) {
    assert.ok(body.includes(f), `重新申请没有清掉 ${f}`);
  }
});

test('手机号匹配只认在营的物业公司', () => {
  /*
   * 实测：授权手机号后提示「已自动绑定 1 处房屋」，而首页什么都没有 ——
   * 匹配到的那套房属于一个已停用的租户，业主端已经把它过滤掉了。
   * 系统宣称做了一件事，实际什么也没发生，而且发生在新业主进来的第一步。
   */
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps/api/src/auth/auth.service.ts'),
    'utf8',
  );
  const i = src.indexOf('const houses = await this.prisma.raw.house.findMany');
  assert.ok(i > 0, '找不到手机号匹配的查询');
  const q = src.slice(i, src.indexOf('});', i));
  assert.match(q, /community: \{ tenant: \{ status: 'ACTIVE' \} \}/, '没有排除已停用的物业公司');
});

test('「我的」页与首页对同一件事说同一句话', () => {
  /*
   * 首页说「已解除」而「我的」说「已驳回」，同一件事两种说法，
   * 比说错更让人糊涂。
   */
  const js = read('pages/mine/mine.js');
  assert.match(js, /b\.revokedAt \? '已解除' : '已驳回'/, '「我的」页没有区分解除与驳回');
  assert.match(js, /b\.revokedAt \? b\.revokeReason : b\.rejectReason/, '原因取错了字段');
});

/*
 * ── 一屏只说一件事 ──
 *
 * 2026-08-02 实测，业主的「我的」页同时摆着三样东西：
 *   卡片：「尚未绑定房屋 / 点击绑定您的房屋 / 去绑定 ›」
 *   一行：「金港城 1 栋 1 单元 101 · 已解除（手机号变更，自动…」← 废弃租户的历史
 *   一行：「金港城 1栋1单元101 · 审核中」                    ← 真正在走的申请
 *
 * 三个入口指向同一件事，两条记录长得一模一样，业主的原话是
 * 「我根本搞不懂作为一个新用户是怎么使用这个小程序」。
 */

test('有在途申请时，「我的房屋」卡不再叫人去绑定', () => {
  const wxml = readWxml('pages/mine/mine.wxml');
  assert.match(wxml, /wx:elif="\{\{!currentHouse && hasPendingApply\}\}"/, '缺少「审核中」这一态');
  const i = wxml.indexOf('绑定申请审核中');
  assert.ok(i > 0);
  const branch = wxml.slice(i, wxml.indexOf('</view>\n\n', i));
  assert.ok(!/bindtap="goBind"/.test(branch), '审核中的卡片仍然可点去绑定');
  // 「去绑定」那一态必须排在它后面，否则永远轮不到审核中
  assert.ok(
    wxml.indexOf('hasPendingApply') < wxml.indexOf('点击绑定您的房屋'),
    '「审核中」分支必须排在「去绑定」之前',
  );
});

test('有在途申请时不再列出已结束的历史记录', () => {
  /*
   * 他已经在走流程了，上一轮的结论跟他没关系 ——
   * 而且两条记录房号一模一样，摆在一起只会让人分不清该点哪个。
   */
  const js = read('pages/mine/mine.js');
  assert.match(js, /pending\.length > 0 \? pending : finished\.slice\(0, 1\)/, '没有「有在途就只显示在途」的规则');
});

test('原因单独一行、允许换行——截断之后一个有用的字都不剩', () => {
  /*
   * 原来把原因塞进「房号 · 状态（原因）」同一行再 ellipsis，
   * 实测显示成「已解除（手机号变更，自动…」。
   * 读不出信息的截断等于没有这段文字，还占着地方。
   */
  const wxml = readWxml('pages/mine/mine.wxml');
  assert.match(wxml, /class="pending-why"/, '原因没有独立成行');
  const wxss = read('pages/mine/mine.wxss');
  const i = wxss.indexOf('.pending-why');
  assert.ok(i > 0, '缺少 .pending-why 样式');
  const rule = wxss.slice(i, wxss.indexOf('}', i));
  assert.ok(!/white-space:\s*nowrap/.test(rule), '原因仍被限制成不换行');
});

test('业主端不返回已停用物业公司的绑定记录', () => {
  /*
   * 那些记录对业主毫无价值 —— 他连那个小区都搜不到，「重新申请」点了也没用。
   */
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps/api/src/owner/owner-houses.controller.ts'),
    'utf8',
  );
  const i = src.indexOf('async myBindings');
  const body = src.slice(i, src.indexOf('\n  }', i));
  assert.match(body, /community: \{ tenant: \{ status: 'ACTIVE' \} \}/, 'myBindings 没有排除停用公司');
});

test('系统自动解除的原因要说人话、且说准', () => {
  /*
   * 原文案「手机号变更，自动解除仅手机匹配绑定」两处不对：
   *   · 不一定是手机号变了（实测那次是物业公司被停用）
   *   · 「仅手机匹配绑定」是内部说法，业主看不懂
   * 而且业主端会把它标成「物业填写的原因」，但这是系统做的 ——
   * 所以文案自己要说清是自动解除。
   */
  /*
   * 只看**真正发给业主的那个字符串**，不看整份源码。
   * 第一版在整份文件上匹配，命中了注释里引用的旧文案 ——
   * 而那段引用正是在解释「旧文案为什么不对」，是有价值的，不该被判成缺陷。
   * 这是今天第四次踩「注释里有同一句话」这个坑了。
   */
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'apps/api/src/auth/auth.service.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = /revokeReason:\s*'([^']*)'/.exec(src);
  assert.ok(m, '找不到自动解除的原因文案');
  assert.ok(!m[1].includes('仅手机匹配绑定'), `仍在用内部说法：${m[1]}`);
  assert.match(m[1], /系统自动解除/, '没有说清是系统自动做的');
});
