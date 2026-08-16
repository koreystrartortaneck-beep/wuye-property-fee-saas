const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 管理端分包(物业人员用,免密:微信授权手机号匹配管理员名单)。
 *
 * 这个文件钉三类事:
 *   ① 分包边界 —— 管理端必须整个待在 packageAdmin 里,业主端零引用。
 *      这既是包体积的事(业主永不下载),也是将来拆成独立小程序的边界。
 *   ② 令牌纪律 —— 管理员令牌只放内存,绝不落存储;
 *      借手机给别人用小程序时,存储里躺着管理令牌就是事故。
 *   ③ 静默失败 —— 探测「是不是管理员」失败一律等于「不是」,
 *      普通业主的正常路径上不能弹任何错。
 */

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'apps/miniprogram');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('分包在 app.json 注册,三个页面文件齐全', () => {
  const app = JSON.parse(read('app.json'));
  const sub = (app.subpackages || []).find((s) => s.root === 'packageAdmin');
  assert.ok(sub, 'packageAdmin 分包未注册');
  for (const p of sub.pages) {
    for (const ext of ['.js', '.wxml', '.json']) {
      assert.ok(fs.existsSync(path.join(MP, 'packageAdmin', p + ext)), `缺文件 packageAdmin/${p}${ext}`);
    }
  }
  // 管理端页面绝不能出现在主包 pages 里 —— 那等于业主也下载它
  for (const p of app.pages) assert.ok(!p.includes('packageAdmin'), '管理页混进了主包');
});

test('管理员令牌只在内存,不落存储', () => {
  const src = stripJs(read('utils/admin.js'));
  assert.ok(!/setStorageSync|setStorage\(/.test(src), '管理员令牌被写进了存储');
  // 会话变量存在且换发失败会清空
  assert.match(src, /session = null/, '失败路径没有清空会话');
});

test('探测失败 = 不是管理员,静默,不打扰业主', () => {
  const src = read('utils/admin.js');
  assert.match(src, /silent: true/, '探测请求没有 silent——普通业主会看到报错 toast');
  const mine = stripJs(read('pages/mine/mine.js'));
  assert.match(mine, /exchangeAdmin\(\)\.then/, '「我的」页没有静默探测');
});

test('「物业工作」整段按管理员身份显隐——标题和卡片都要各自挂条件', () => {
  /*
   * 业主不该看到这一段。它由「微信授权手机号是否在管理员名单里」决定
   * (服务端 /auth/admin-exchange 判定,探测失败一律按「不是」)。
   *
   * 这里逐个检查而不是只看一处:标题和卡片是**两个并列的 view**,
   * 各自挂着 wx:if。少挂一个,业主就会看到一个孤零零的「物业工作」标题 ——
   * 那既是信息泄露(告诉他这里有管理功能),也会让他以为自己该有这个入口。
   * 将来往这一段里再加东西,这条会立刻变红。
   */
  const wxml = read('pages/mine/mine.wxml').replace(/<!--[\s\S]*?-->/g, '');
  const start = wxml.indexOf('物业工作');
  assert.ok(start > 0, '「物业工作」整段不见了');
  const block = wxml.slice(wxml.lastIndexOf('<view', start), wxml.indexOf('build-stamp'));
  const openers = block.match(/<view[^>]*class="(?:section-title|menu-card)[^"]*"[^>]*>/g) || [];
  assert.ok(openers.length >= 2, `没找到「物业工作」的标题与卡片(找到 ${openers.length} 个)`);
  for (const o of openers) {
    assert.match(o, /wx:if="\{\{adminName\}\}"/, `这一段里有没挂条件的元素,业主会看见:${o}`);
  }
  // adminName 只能来自静默探测的结果,失败必须落回空串(否则会「默认显示」)
  const js = stripJs(read('pages/mine/mine.js'));
  assert.match(js, /adminName: admin \? admin\.name : ''/, '探测失败没有把入口收回去');
});

test('管理端请求走令牌覆盖;管理令牌 40100 不触发业主重登', () => {
  /*
   * request.js 的 40100 自动重登拿到的是**业主**身份 ——
   * 用它重放 /admin/* 请求只会再 401 一次并可能吞掉真实原因。
   * 管理令牌失效必须走重新换发(admin.js 自己处理)。
   */
  const req = stripJs(read('utils/request.js'));
  assert.match(req, /token \|\| getToken\(\)/, 'request 不支持令牌覆盖'); // bearer = token || getToken()
  assert.match(req, /&& !options\.token/, '管理令牌 401 走了业主重登');
  const adm = stripJs(read('utils/admin.js'));
  assert.match(adm, /token: s\.token/, 'adminRequest 没带管理员令牌');
});

test('业主端主包没有任何文件引用 packageAdmin 之外的管理逻辑', () => {
  /*
   * 允许:pages/mine 引 utils/admin(入口探测)。
   * 除此之外主包任何页面 require utils/admin 都是分包边界被打穿的信号。
   */
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(MP, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'packageAdmin') continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js') && stripJs(read(rel)).includes("utils/admin")) offenders.push(rel);
    }
  };
  walk('pages');
  assert.deepEqual(offenders, ['pages/mine/mine.js'], `管理逻辑泄出分包:${offenders.join(', ')}`);
});

test('房屋详情是单户作业台:这一户的信息可改、标准可换、只给这户发账单', () => {
  /*
   * 实测反馈:「我选中某一个,点进去之后应该是只给这一户编辑+发账单」。
   * 这一页必须自带编辑(面积/放户日期直接决定金额与出账月)和挂标准,
   * 而「发账单」必须落到单户页,不能再把人扔回批量流程里选范围。
   */
  const js = stripJs(read('packageAdmin/pages/house/house.js'));
  assert.match(js, /method: 'PATCH'/, '房屋信息不能在这一页改');
  assert.match(js, /handoverDate/, '没法改放户日期——那是出账月份的唯一依据');
  assert.match(js, /houses\/\$\{this\.data\.id\}\/standards/, '不能在这一页挂/摘收费标准');
  assert.match(js, /pages\/bill-one\/bill-one\?id=/, '「给这户发账单」没有落到单户页');
  // 改面积/放户日期会改钱和出账月,必须先说清后果
  assert.match(js, /showModal[\s\S]{0,400}放户日期改为/, '改放户日期没有讲清后果');
});

test('首页是楼盘图:楼栋条 → 层格子,欠费格标金额,点格进房', () => {
  /*
   * 实测反馈:「操作特别不方便,能不能做成楼盘表格那样」。
   * 搜索是接电话用的;日常巡查靠空间视图 —— 这条钉住别退回纯搜索。
   */
  const wxml = read('packageAdmin/pages/home/home.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(wxml, /pickBuilding/, '没有楼栋切换');
  assert.match(wxml, /wx:for="\{\{u\.floors\}\}"/, '没有按层铺格子');
  assert.match(wxml, /cell-unpaid/, '欠费格没有红色状态类');
  assert.match(wxml, /\{\{item\.unpaidAmount\}\}/, '欠费格没有金额');
  assert.match(wxml, /data-id="\{\{item\.id\}\}" bindtap="goHouse"/, '格子点不进房屋详情');
  // 搜索保留:接电话查户仍是它最快
  assert.match(wxml, /bindinput="onKeywordInput"/, '搜索框被删掉了');
});

test('探测必须等业主登录完成——竞态会把管理员误判成普通人', () => {
  /*
   * 实测:首次启动时探测赶在 wx.login 前发出,页面显示「没有管理权限」,
   * 而服务端审计里躺着成功换发记录。竞态给的是假答案,且只在首启出现。
   */
  const src = read('utils/admin.js');
  const i = src.indexOf('async function exchangeAdmin');
  const body = src.slice(i, src.indexOf('admin-exchange', i));
  assert.match(body, /await getApp\(\)\.loginReady/, 'exchangeAdmin 没有先等 loginReady');
});

test('adminRequest 绝不许调 /owner/ 接口——令牌与门不匹配', () => {
  /*
   * 2026-08-03 实测:楼盘图拿小区列表调了 /owner/communities,
   * 管理员令牌被 OwnerGuard 拒 → 异常抛到外层 → 被渲染成「没有管理权限」。
   * 用户明明有权限(审计里躺着成功换发),界面却说他没有。
   * 这类错编译期查不出来,只能在这里全量扫。
   */
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(MP, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) {
        const src = stripJs(read(rel));
        for (const m of src.matchAll(/adminRequest\(\s*[`'"](\/owner\/[^`'"]*)/g)) {
          offenders.push(`${rel} → ${m[1]}`);
        }
      }
    }
  };
  walk('packageAdmin');
  assert.deepEqual(offenders, [], `管理员令牌开不了业主端的门:\n  ${offenders.join('\n  ')}`);
});

test('「没有管理权限」只允许由身份换发失败触发', () => {
  /*
   * denied 状态若被数据加载失败也能置上,错误页就在说谎 ——
   * 对着有权限的人说「你没权限」,他只会去反复检查一个没坏的登记。
   */
  const src = stripJs(read('packageAdmin/pages/home/home.js'));
  const sets = [...src.matchAll(/denied: true/g)];
  assert.equal(sets.length, 1, 'denied:true 出现了多于一处——检查是否有别的失败也在冒充权限错误');
  const i = src.indexOf('denied: true');
  const before = src.slice(Math.max(0, i - 300), i);
  assert.match(before, /ensureAdmin/, 'denied 不是由 ensureAdmin 的失败触发的');
  // 楼盘图有自己的失败态与重试
  assert.match(src, /gridError/, '楼盘图加载失败没有独立的错误态');
});

test('发账单三种范围:批量页管全部/楼栋,单户走 bill-one,都用 onlyHouseIds', () => {
  /*
   * 「某一户 / 某一群 / 所有」是明确需求,但**入口分开**:
   * 实测反馈「点进一户之后应该只给这一户编辑+发账单,现在非常混乱」——
   * 混乱来自把单户塞进批量流程,为了一户要选标准、选月份、选范围。
   * 三者仍共用 onlyHouseIds:全部 = 不传,楼栋 = 该栋全部格子,单户 = 一个 id。
   * 预览必须带同样的定向 —— 否则「选了 3 户」却预览全量,人核对的是另一批账。
   */
  const js = stripJs(read('packageAdmin/pages/billing/billing.js'));
  assert.match(js, /scope: 'all'/, '缺少「全部」范围');
  assert.match(js, /'building'/, '缺少「按楼栋」范围');
  assert.match(js, /scopeHouseIds\(\)[\s\S]{0,400}return undefined/, '「全部」没有走不定向路径');
  assert.match(js, /onlyHouseIds=\$\{ids\.join\(','\)\}/, '预览没有带定向参数');
  assert.match(js, /body\.onlyHouseIds = ids/, '出账没有带定向参数');
  // 批量页不许再长出「某一户」:那正是被判定为混乱的东西
  const wxml = read('packageAdmin/pages/billing/billing.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/data-s="house"/.test(wxml), '批量页又出现了「某一户」范围选择');

  const one = stripJs(read('packageAdmin/pages/bill-one/bill-one.js'));
  assert.match(one, /onlyHouseIds: \[this\.data\.id\]/, '单户页出账没有定向到这一户');
  assert.match(one, /onlyHouseIds=\$\{this\.data\.id\}|onlyHouseIds=\$\{[^}]*id\}/, '单户页预览没有定向到这一户');
});

test('单户出账不给人做选择:月份由放户日推导,标准取这户挂着的', () => {
  /*
   * 实测:从房屋详情进发账单,默认月份是「当前月」,而这户的收费月是 3 月
   * → 页面显示「0 户可出账 ¥0.00」。人没做错任何事,却看到一个空白结果。
   * 单户页必须自己算出月份(锚点月 = 放户日的月),并且只列这户挂着的标准。
   */
  const js = stripJs(read('packageAdmin/pages/bill-one/bill-one.js'));
  assert.match(js, /houses\/\$\{this\.data\.id\}\/standards/, '没有读这户挂着的收费标准');
  assert.match(js, /anchor\.slice\(5, 7\)/, '月份不是从放户日期推导的');
  assert.ok(!/scope/.test(js), '单户页出现了「范围」这种概念');
  // 提前收费要说出来,不能默默生成一张还没到期的账单
  assert.match(js, /提前/, '收费月还没到时没有提示这是提前收');
});

test('出不了账要说出真正的原因——「停用」不能显示成「这个月不该出账」', () => {
  /*
   * 2026-08-04 实测:一套停用的房屋点「给这户发账单」,页面只说
   * 「按这条标准,这个月不该给这户出账」。真因是**房屋停用**
   * (服务端选房时 house.status 必须是 ACTIVE),而那句话把人指向了账期,
   * 于是只能反复点。
   *
   * 两处都要说:房屋详情的按钮之前先提示,单户出账页给出原因 + 改法。
   * 「预览里没有这户」的兜底文案也必须列全可能性,不能只说「不该出账」。
   */
  const one = stripJs(read('packageAdmin/pages/bill-one/bill-one.js'));
  assert.match(one, /house\.status && house\.status !== 'ACTIVE'/, '单户出账页没有识别停用状态');
  assert.match(one, /停用[\s\S]{0,80}在用/, '没有告诉人怎么改回来');
  assert.match(one, /房屋已停用、这条标准已被摘除/, '兜底文案没有列全真实可能性');
  const houseWxml = read('packageAdmin/pages/house/house.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(houseWxml, /house\.status !== 'ACTIVE'[\s\S]{0,200}停用/, '房屋详情没有在发账单按钮前提示停用');
});

test('剔除之后顶上的合计必须跟着变——数字不动等于说剔除没生效', () => {
  /*
   * 原来大数字写死成预览返回的合计:剔掉 15 户后仍显示 ¥56758。
   * 8 月那批 34 户里有 15 户线下已交,这个数字错了就直接错在钱上。
   */
  const js = stripJs(read('packageAdmin/pages/billing/billing.js'));
  assert.match(js, /recompute\(\)/, '没有按剔除重算合计');
  assert.match(js, /amountCents/, '合计不是按分币整数累加的');
  const wxml = read('packageAdmin/pages/billing/billing.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(wxml, /sum-num[^>]*>¥\{\{willTotal\}\}/, '大数字没有绑到实时合计 willTotal');
  assert.ok(!/¥\{\{total\}\}/.test(wxml), '页面上还留着不随剔除变化的预览合计');
});

test('楼盘图格子定列数:房号必须读得出来', () => {
  /*
   * 实测截图:门市一层 11 户,格子 flex:1 撑满整行 → 每格约 60rpx,
   * 001~011 挤成「001002003…」,一个房号都读不出来。
   * 定列数(≤4)顺带把每层同一列对齐,和纸质楼盘表一致。
   */
  const js = stripJs(read('packageAdmin/pages/home/home.js'));
  assert.match(js, /Math\.min\(4/, '列数没有上限');
  const wxss = read('packageAdmin/pages/home/home.wxss');
  assert.match(wxss, /\.cols-4 \.cell/, '缺少定列数的宽度规则');
  assert.ok(!/\.cell \{[^}]*flex: 1;/.test(wxss), '格子又回到了 flex:1 撑满整行');
});

test('待办数字必须落在能点进去的入口上,不许出现「请回电脑处理」', () => {
  /*
   * 待办条(黄色 chip)已删 —— 用户嫌丑,且和标签角标重复。
   * 但它的三个数字不能跟着消失,得各有去处:
   *   报修/待发布 → 标签角标;绑定审批 → 底部自己的按钮(它是自助申请的唯一出口)。
   * 也不许回到「点了弹请回电脑后台」的老路 —— 手机端全都能办。
   */
  const js = stripJs(read('packageAdmin/pages/home/home.js'));
  assert.match(js, /draftCount/, '待发布数字丢了');
  assert.match(js, /ticketCount/, '报修数字丢了');
  assert.match(js, /bindingCount/, '绑定审批数字丢了');
  assert.match(js, /\/packageAdmin\/pages\/approvals\/approvals/, '绑定审批失去了唯一入口');
  assert.ok(!/请在电脑后台处理/.test(js), '又出现了「请在电脑后台处理」');
  const wxml = read('packageAdmin/pages/home/home.wxml');
  assert.match(wxml, /draftCount > 0/, '待发布标签的角标条件不见了');
  assert.match(wxml, /goApprovals/, '绑定审批按钮不见了');
  assert.ok(!/todo-strip/.test(wxml), '待办条又回来了');
});

test('整批发布:户数取库里的草稿条数,剔除要留原因', () => {
  /*
   * ① 发布按钮上的户数不能用批次生成时写下的 validRows —— 剔除过就偏大,
   *    写错就是当着人说谎。
   * ② 剔除 = 作废这一行草稿账单,必须问原因(线下已收 / 不该出),
   *    下个月有人问「这户为什么没账单」时,审计里那句话是唯一答案。
   */
  const js = stripJs(read('packageAdmin/components/batch-panel/index.js'));
  assert.match(js, /status=DRAFT&pageSize=1/, '户数没有从库里的草稿条数取');
  assert.ok(!/validRows/.test(js), '户数用了批次上可能过期的 validRows');
  assert.match(js, /showActionSheet[\s\S]{0,300}线下已/, '剔除没有问原因');
  assert.match(js, /bills\/\$\{row\.id\}\/cancel/, '剔除没有走作废接口');
  assert.match(js, /showModal[\s\S]{0,300}b\.count[\s\S]{0,200}发布/, '发布前没有带户数的二次确认');
  /*
   * ③ 草稿必须有第二条出路。只有「发布」一条路时,一个不该发的草稿
   *    (历史遗留规则每月自动生成的那种)会永久占着待办红点,人最后会去点发布 ——
   *    错价的测试账单就这样进了业主手机。
   */
  assert.match(js, /bill-batches\/\$\{b\.id\}\/cancel/, '草稿批次没有「整批不发」的出路');
  assert.match(js, /整批作废/, '整批作废没有说清后果');
});

test('发布是人点的最后一下,且发布前必须确认户数', () => {
  /*
   * 这是钱。自动化只做准备(草稿),发布永远要人确认 ——
   * 且确认框必须写清「多少户会立即看到」,不能只说「确认发布?」。
   */
  const js = stripJs(read('packageAdmin/pages/billing/billing.js'));
  assert.match(js, /showModal[\s\S]{0,300}b\.count[\s\S]{0,200}发布/, '发布前没有带户数的二次确认');
  assert.match(js, /bill-batches\/\$\{b\.id\}\/publish/, '没有调发布接口');
  // 批次数字取自后端批次,不能拿预览数字充数
  assert.match(js, /admin\/bill-batches\?period=/, '发布按钮上的户数/金额没有取自真实批次');
});

test('线下收款:金额不给改、单据号必填、重复提交不重复收款', () => {
  /*
   * ① 金额来自账单,收多少是账单说的 —— 页面上绝不能出现金额输入框
   *   (系统只支持整笔核销,给个输入框等于骗人)。
   * ② 提交前现查一遍账单状态:上一页的数字可能已过时(别人刚收过/账单被作废),
   *   拿过时的金额收现金是真金白银的错。
   * ③ requestId 由「账单+单据号」拼出:手抖点两下是同一次(服务端重放同一张收据),
   *   换了单据号才算另一次。
   */
  const js = stripJs(read('packageAdmin/pages/collect/collect.js'));
  const wxml = read('packageAdmin/pages/collect/collect.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/data-k="amount"|k: 'amount'/.test(js + wxml), '收款页出现了金额输入');
  assert.match(js, /status=UNPAID/, '没有现查账单状态就收钱');
  assert.match(js, /requestId: `mp-offline-\$\{this\.data\.billId\}-\$\{voucherNo/, 'requestId 没有绑定账单+单据号');
  assert.match(js, /voucherNo\)\s*return wx\.showToast|if \(!voucherNo\)/, '单据号没有必填校验');
  assert.match(wxml, /收据号/, '收完没有显示收据号');
});

test('退款只能全额原路退回,且必须填原因', () => {
  /*
   * 退款接口不接受金额(一律按原订单全额),所以界面绝不能给金额输入框 ——
   * 给了就是让人以为能退一部分。原因必填:审计里那句话是以后唯一的解释。
   * 403 要说清是权限问题(退款限管理员),而不是让人反复重试。
   */
  const js = stripJs(read('packageAdmin/pages/house/house.js'));
  assert.match(js, /admin\/refunds/, '没有调退款接口');
  assert.match(js, /全额退/, '确认框没有说清是全额退款');
  assert.match(js, /askText\('退款原因'/, '退款没有要求填原因');
  assert.match(js, /40300[\s\S]{0,200}管理员/, '403 没有解释成权限问题');
  // 冲正:线下收款记错了的出路,同样要原因
  assert.match(js, /reverse-offline/, '线下收款没有冲正的出路');
  assert.match(js, /askText\('冲正原因'/, '冲正没有要求填原因');
});

test('催缴:合计取后端全量口径,截断要说出来,发送结果如实报数', () => {
  /*
   * ① 欠费总额是拿去汇报的数。列表是截断过的,自己把这几行加起来会比真实欠费少。
   * ② queued 数的是**账单条数**(一户欠三期就是三条)——说成「已通知 N 户」是假话。
   * ③ 提醒走微信订阅消息,业主没授权就收不到,界面必须明说,
   *   否则物业以为发过了、业主那边什么都没响。
   */
  const js = stripJs(read('packageAdmin/components/arrears-panel/index.js'));
  assert.match(js, /total: d\.totalAmount/, '欠费合计不是取后端全量口径');
  assert.match(js, /truncated/, '列表截断没有告知');
  assert.match(js, /r\.queued/, '发送结果没有用后端的真实条数');
  assert.ok(/没授权/.test(js) || /没授权/.test(read('packageAdmin/components/arrears-panel/index.wxml')), '没有说明订阅未授权收不到');
  assert.match(js, /admin\/arrears\/dun/, '没有调催缴接口');
});

test('工单:受理要填处理人、办结要填回复——业主两样都看得到', () => {
  /*
   * 「一键办结」留下的是一条没人看得懂的记录,业主只会再报一次。
   * 两个接口后端都要求非空,页面用可编辑弹窗提前挡住空输入。
   */
  const js = stripJs(read('packageAdmin/components/ticket-panel/index.js'));
  assert.match(js, /tickets\/\$\{id\}\/process/, '没有受理接口');
  assert.match(js, /tickets\/\$\{id\}\/done/, '没有办结接口');
  assert.match(js, /editable: true/, '受理/办结没有可输入的弹窗');
  assert.match(js, /业主会看到/, '没有告知这些字业主可见');
  // 枚举文案必须取自 utils/labels(与后端枚举有守卫比对),页面不许自建映射
  assert.match(js, /require\('\.\.\/\.\.\/\.\.\/utils\/labels'\)/, '工单状态文案没有走 utils/labels');
});

test('欠费/报修/待发布:首页标签与独立页面共用同一个组件,不许各抄一份', () => {
  /*
   * 首页要在一屏内横向切「楼盘图 / 欠费 / 报修 / 待发布」,而这三块各有几十行逻辑。
   * 把它们抄一份进首页就是「改一处漏一处」的开始 —— 这个仓库已经在
   * 账单状态文案上栽过一次(列表页补了 REFUNDED,详情页漏了,业主看到英文)。
   * 所以:实现只许有一份(组件),页面和首页都只是它的两个入口。
   */
  const PANELS = [
    ['arrears-panel', 'pages/dun/dun'],
    ['ticket-panel', 'pages/tickets/tickets'],
    ['batch-panel', 'pages/batches/batches'],
  ];
  const app = JSON.parse(read('app.json'));
  const homeJson = JSON.parse(read('packageAdmin/pages/home/home.json'));
  const homeWxml = read('packageAdmin/pages/home/home.wxml').replace(/<!--[\s\S]*?-->/g, '');
  for (const [comp, page] of PANELS) {
    // 组件四件套齐全
    for (const ext of ['.js', '.wxml', '.json', '.wxss']) {
      assert.ok(
        fs.existsSync(path.join(MP, `packageAdmin/components/${comp}/index${ext}`)),
        `缺组件文件 ${comp}/index${ext}`,
      );
    }
    // 独立页面只剩一层壳:不许再有自己的实现
    const pageJs = stripJs(read(`${'packageAdmin/'}${page}.js`));
    assert.ok(!/adminRequest\(/.test(pageJs), `${page} 又自己发请求了——实现应该只在 ${comp} 里`);
    assert.match(read(`packageAdmin/${page}.wxml`), new RegExp(`<${comp}\\b`), `${page} 没有用 ${comp}`);
    // 首页把同一个组件当标签用
    assert.equal(homeJson.usingComponents[comp], `../../components/${comp}/index`, `首页没注册 ${comp}`);
    assert.match(homeWxml, new RegExp(`<${comp}\\b`), `首页没有把 ${comp} 当标签用`);
  }
  // 组件只在被看着时才拉数据
  const one = stripJs(read('packageAdmin/components/arrears-panel/index.js'));
  assert.match(one, /observer\(on\)[\s\S]{0,80}this\.load\(\)/, '面板没有按 active 触发加载');
  assert.ok(app.subpackages.some((x) => x.root === 'packageAdmin'), '分包不见了');
});

test('发公告:发布即可见,所以要确认受众;可撤回但要说清收不回', () => {
  const js = stripJs(read('packageAdmin/pages/announce/announce.js'));
  assert.match(js, /本公司全部小区|本小区/, '确认框没有说清受众范围');
  assert.match(js, /admin\/announcements/, '没有调公告接口');
  const wxml = read('packageAdmin/pages/announce/announce.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(/看过的人收不回来|收不回来/.test(js + wxml), '撤回没有说清「看过的人收不回」');
});

test('员工与权限:收费员看不到会 403 的按钮,且界面显隐只是免死按钮', () => {
  /*
   * 两个角色的差别必须在界面上兑现,否则收费员点一下退款得到 403,
   * 只会以为系统坏了 —— 死按钮比没有按钮糟。
   *
   * 但显隐**不是**权限:门在服务端的 @Roles 上(整个 /admin/staff 控制器限管理员,
   * 退款/冲正/整批作废各自限管理员)。这里钉的是「不给死按钮 + 说清找谁」。
   */
  const homeJs = stripJs(read('packageAdmin/pages/home/home.js'));
  const homeWxml = read('packageAdmin/pages/home/home.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(homeJs, /isAdmin: s\.role === 'TENANT_ADMIN'/, '首页没有按角色判断管理员');
  assert.match(homeWxml, /wx:if="\{\{isAdmin\}\}"[\s\S]{0,120}员工与权限/, '「员工与权限」入口没有按角色显隐');

  const houseJs = stripJs(read('packageAdmin/pages/house/house.js'));
  assert.match(houseJs, /canRefund: isAdmin &&/, '退款按钮没有按角色显隐');
  assert.match(houseJs, /canReverse: isAdmin &&/, '冲正按钮没有按角色显隐');
  const houseWxml = read('packageAdmin/pages/house/house.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(houseWxml, /!isAdmin[\s\S]{0,120}找管理员/, '收费员看不到退款时没有说清该找谁');
  assert.match(houseWxml, /wx:if="\{\{isAdmin\}\}" class="danger"/, '删房的危险区没有按角色显隐');

  // 员工页三件必须说清的事(实测里人会卡住的地方)
  const staffJs = stripJs(read('packageAdmin/pages/staff/staff.js'));
  assert.match(staffJs, /只显示这一次/, '没有说清初始密码只显示一次');
  assert.match(staffJs, /admin\/staff/, '没有调员工接口');
  assert.match(staffJs, /当场失效/, '停用/重置没有说清旧登录状态立刻失效');
  const staffWxml = read('packageAdmin/pages/staff/staff.wxml').replace(/<!--[\s\S]*?-->/g, '');
  // 2026-08-05 起手机通道不再受「首次改密」限制(pv 令牌),文案必须说的是这个新事实
  assert.match(staffWxml, /授权手机号即可进入管理端/, '没有说清「填了号授权即可进入」');
  assert.ok(!/也要先在电脑后台登录一次改密/.test(staffWxml), '还在说旧规则(填了号也要先电脑改密)');
});

test('新建房屋:房号实时预览归入位置,解析规则不在小程序里复制一份', () => {
  /*
   * 2026-08-05 用户建「003-013」,认不出的形状进了「其他」组 ——
   * 房建成了,但楼盘图上找不到,看起来就像「没绑定到楼盘」。
   * 预览必须问后端(/admin/houses-grid/parse):规则只在 parseHouseCode 一处,
   * 小程序复制一份的话,早晚和真的对不上。
   */
  const js = stripJs(read('packageAdmin/pages/house-new/house-new.js'));
  assert.match(js, /houses-grid\/parse/, '房号没有实时问「会归到哪」');
  assert.ok(!/期\\d|\[A-Z\]\)-\(/.test(js), '解析规则被复制进了小程序');
  const wxml = read('packageAdmin/pages/house-new/house-new.wxml');
  assert.match(wxml, /gridHint/, '预览提示没有渲染');
});

test('已退款/已作废的账单在手机上有出路:重开', () => {
  /*
   * 没有重开的话手机端是死局:退了款想重新收这一年,
   * 批量/单户出账都会被「同年已有非 CANCELED 账单」的查重挡住,
   * 而重开原来只在电脑后台有 —— 物业员工可能根本不用电脑。
   */
  const js = stripJs(read('packageAdmin/pages/house/house.js'));
  assert.match(js, /canReissue: b\.status === 'REFUNDED' \|\| b\.status === 'CANCELED'/, '重开没有跟着状态给');
  assert.match(js, /bills\/\$\{id\}\/reissue/, '没有调重开接口');
  assert.match(js, /askText\('重开原因'/, '重开没有问原因');
  assert.match(js, /showModal[\s\S]{0,600}业主立刻能看到/, '重开前没有说清业主立刻可见');
  const wxml = read('packageAdmin/pages/house/house.wxml');
  assert.match(wxml, /canReissue[\s\S]{0,200}重开账单/, '重开按钮没有渲染');
});

test('单户出账失败时,只许解释这一户自己的原因', () => {
  /*
   * 2026-08-09 实测:A-1-1002 页面顶着「放户 2026-08-10」,弹窗却说
   * 「这户没填放户日期」—— 那是 skippedDetail[0],另一套房的原因。
   * 必须按 houseId 找自己的那条;同期账单已存在也要说人话并指路。
   */
  const js = stripJs(read('packageAdmin/pages/bill-one/bill-one.js'));
  assert.match(js, /\.find\(\(x\) => x\.houseId === this\.data\.id\)/, '没按 houseId 找自己的跳过原因');
  assert.ok(!/skippedDetail\[0\]\.reason/.test(js), '又在拿 skippedDetail[0] 当自己的原因');
  assert.match(js, /PERIOD_ALREADY_EXISTS: '[^']*已经存在[^']*账单/, '「这期账单已存在」没有人话解释');
});

test('「功能」页签:要 communityId 的入口必须自己把门', () => {
  /*
   * 功能卡一进页面就可点,而 communityId 要等楼盘图接口回来才有 ——
   * 发账单/新增房屋/发公告 没有它就是带病打开(表单能填,提交才失败)。
   */
  const js = stripJs(read('packageAdmin/pages/home/home.js'));
  for (const fn of ['goBilling', 'goAnnounce', 'goNewHouse']) {
    const i = js.indexOf(`${fn}()`);
    assert.ok(i > 0, `${fn} 不见了`);
    assert.match(js.slice(i, i + 200), /needCommunity\(\)/, `${fn} 没把 communityId 的门`);
  }
  const wxml = read('packageAdmin/pages/home/home.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(wxml, /tab === 'tools'/, '「功能」页签不见了');
  assert.ok(!/class="quick"/.test(wxml) && !/entry-row/.test(wxml), '楼盘图底部的按钮堆又回来了');
});

test('扫码核销:只认 PFC: 前缀,业主端亮码与员工端扫码前缀一致', () => {
  /*
   * 物业拍板:券到前台兑奖品,扫码核销。前缀是两端的握手协议 ——
   * 员工端扫到不带前缀的码(付款码/网址)必须明确拒绝,
   * 不拿陌生字符串去撞券库;业主端出的码必须带同一个前缀。
   */
  const staff = stripJs(read('packageAdmin/pages/coupon-verify/coupon-verify.js'));
  assert.match(staff, /wx\.scanCode/, '员工端没有扫码入口');
  assert.match(staff, /startsWith\('PFC:'\)/, '扫码没有校验前缀');
  assert.match(staff, /不是本系统的券码/, '扫到别家的码没有人话拒绝');
  const owner = stripJs(read('pages/coupons/coupons.js'));
  assert.match(owner, /\/owner\/my\/coupons\/\$\{id\}\/qr/, '业主端没有取码接口');
  const ownerWxml = read('pages/coupons/coupons.wxml');
  assert.match(ownerWxml, /亮码核销/, '业主端没有亮码入口');
  assert.match(ownerWxml, /item\.status === 'UNUSED'[^<]*showQr/, '已核销/过期的券也能亮码');
});

test('卡券核销:先查后核、核前确认、并发被拒时给服务端原话', () => {
  /*
   * 核销不可逆(核了东西就发出去了):必须先把「这是什么券、还能不能用」
   * 摆在眼前,再要一次确认。两个前台同时核同一张时,服务端只放行一个,
   * 另一个必须看到「刚刚已被核销」原话 —— 不能含糊成「操作失败」。
   */
  const js = stripJs(read('packageAdmin/pages/coupon-verify/coupon-verify.js'));
  assert.match(js, /adminRequest\(`\/admin\/coupons\/verify\//, '没走核销接口');
  assert.match(js, /showModal[\s\S]{0,300}核销后立即失效/, '核销前没有确认弹窗');
  assert.match(js, /found[\s\S]*usable/, '没有先查券再核');
  assert.match(js, /(e && e\.message)/, '服务端拒绝原因没有透传给人');
  // 入口全员可见(收费员就该能核销),不许挂 isAdmin
  const wxml = read('packageAdmin/pages/home/home.wxml').replace(/<!--[\s\S]*?-->/g, '');
  const i = wxml.indexOf('核销卡券');
  assert.ok(i > 0, '首页没有核销入口');
  const tag = wxml.slice(wxml.lastIndexOf('<view', i), i);
  assert.ok(!/isAdmin/.test(tag), '核销入口被错误地限成了管理员');
});

test('管理端可刷新的页面都有下拉刷新,表单页没有', () => {
  /*
   * 下拉刷新是肌肉记忆;但表单页(收款/建房/单户出账)下拉会把填了一半的
   * 内容刷掉 —— 那不是刷新,是事故。两边都要钉住。
   */
  const fs2 = require('node:fs');
  const withPull = ['home', 'house', 'staff', 'approvals', 'tickets', 'dun', 'batches'];
  const noPull = ['collect', 'house-new', 'bill-one', 'billing', 'announce', 'coupon-verify'];
  for (const p of withPull) {
    const cfg = JSON.parse(read(`packageAdmin/pages/${p}/${p}.json`));
    assert.equal(cfg.enablePullDownRefresh, true, `${p} 缺下拉刷新`);
    assert.match(stripJs(read(`packageAdmin/pages/${p}/${p}.js`)), /onPullDownRefresh/, `${p} 没接下拉回调`);
    assert.match(read(`packageAdmin/pages/${p}/${p}.js`), /stopPullDownRefresh/, `${p} 下拉后不收起`);
  }
  for (const p of noPull) {
    const cfg = JSON.parse(read(`packageAdmin/pages/${p}/${p}.json`));
    assert.ok(!cfg.enablePullDownRefresh, `${p} 是表单页,下拉会刷掉填了一半的内容`);
  }
});

test('催缴的发送按钮是浮动操作条,不许再沉回列表底部', () => {
  /*
   * 2026-08-15 实测:67 户欠费的列表里,发送按钮在最底下 ——
   * 勾完人还得滑十几屏去找按钮。改成勾了人就浮出的底部操作条,
   * 且必须给列表垫底(不然最后一行被条盖住勾不着)。
   */
  const wxml = read('packageAdmin/components/arrears-panel/index.wxml');
  assert.match(wxml, /wx:if="\{\{picked\.length > 0\}\}"[\s\S]{0,80}dun-bar/, '操作条没有跟着勾选显隐');
  assert.match(wxml, /dun-bar-pad/, '没给列表垫底,最后一行会被操作条盖住');
  const wxss = read('packageAdmin/components/arrears-panel/index.wxss');
  assert.match(wxss, /\.dun-bar \{[\s\S]{0,120}position: fixed/, '操作条不是固定在屏幕底部');
  assert.match(wxss, /safe-area-inset-bottom/, '全面屏底部没留安全区');
  const js = stripJs(read('packageAdmin/components/arrears-panel/index.js'));
  assert.match(js, /clearPicked/, '没有「清空」——勾错了只能逐个取消');
});

test('发卡券:入口仅管理员,发布前必须把成本摆在眼前确认', () => {
  /*
   * 发行量 × 奖品就是钱。确认框必须写清共几张、每人限几张、有效期到哪天,
   * 且说明「发行量只能改小,已领出的收不回来」。
   */
  const wxml = read('packageAdmin/pages/home/home.wxml').replace(/<!--[\s\S]*?-->/g, '');
  const i = wxml.indexOf('发卡券');
  assert.ok(i > 0, '功能页签没有发卡券入口');
  // 往回找这张卡片的外层 <view class="tool">(lastIndexOf 只会摸到内层的 tool-name)
  const cardStart = wxml.lastIndexOf('class="tool"', i);
  const cardTag = wxml.slice(wxml.lastIndexOf('<view', cardStart), i);
  assert.match(cardTag, /isAdmin/, '发卡券入口没有限管理员');
  const js = stripJs(read('packageAdmin/pages/coupon-new/coupon-new.js'));
  assert.match(js, /showModal[\s\S]{0,400}共 \$\{totalQty\} 张/, '确认框没有写发行总量');
  assert.match(js, /已领出的收不回来/, '没有说清发行量的不可逆性');
  assert.match(js, /DISCOUNT[\s\S]{0,200}必须填面额/, '抵扣券没有强制面额');
  assert.match(js, /validTo < this\.data\.validFrom/, '有效期没有前后校验');
});

test('自动发券:至少一个条件、门槛校验、确认框写清触发方式', () => {
  /*
   * 「满 X 元自动发」这类规则挂在钱的路径上,表单端的三道闸:
   * ① 自动发但一个条件都没设 = 人人缴费都发,大概率是手滑 —— 拦下;
   * ② 金额门槛必须是正数;
   * ③ 确认框必须说清「线上缴费满足条件时自动发」,不能让人以为还是自领。
   */
  const js = stripJs(read('packageAdmin/pages/coupon-new/coupon-new.js'));
  assert.match(js, /自动发至少要设一个条件/, '没拦「零条件自动发」');
  assert.match(js, /minAmount && !\(Number\(minAmount\) > 0\)/, '金额门槛没校验');
  assert.match(js, /自动发到他的卡券里/, '确认框没说清自动发的触发方式');
  assert.match(js, /autoGrant: \{/, '没把规则传给后端');
  const wxml = read('packageAdmin/pages/coupon-new/coupon-new.wxml');
  assert.match(wxml, /缴费自动发/, '表单没有发放方式选项');
});
