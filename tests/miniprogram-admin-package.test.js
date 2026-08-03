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

test('入口按 adminName 显隐;界面显隐只是引导,门在服务端', () => {
  const wxml = read('pages/mine/mine.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(wxml, /wx:if="\{\{adminName\}\}"[\s\S]{0,200}物业管理/, '「物业管理」入口没有按管理员身份显隐');
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

test('待办「已生成待发布」必须能点进去发布,不许再劝人回电脑', () => {
  /*
   * 待办的意义是「这里有事要做」。点下去弹「这类事项请在电脑后台处理」,
   * 等于用一条通知提醒你去办公室 —— 手机端已经能发布了。
   */
  const js = stripJs(read('packageAdmin/pages/home/home.js'));
  assert.match(js, /draftBatch: '\/packageAdmin\/pages\/batches\/batches'/, '待发布待办没有路由到发布页');
});

test('整批发布:户数取库里的草稿条数,剔除要留原因', () => {
  /*
   * ① 发布按钮上的户数不能用批次生成时写下的 validRows —— 剔除过就偏大,
   *    写错就是当着人说谎。
   * ② 剔除 = 作废这一行草稿账单,必须问原因(线下已收 / 不该出),
   *    下个月有人问「这户为什么没账单」时,审计里那句话是唯一答案。
   */
  const js = stripJs(read('packageAdmin/pages/batches/batches.js'));
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

test('发公告:发布即可见,所以要确认受众;可撤回但要说清收不回', () => {
  const js = stripJs(read('packageAdmin/pages/announce/announce.js'));
  assert.match(js, /本公司全部小区|本小区/, '确认框没有说清受众范围');
  assert.match(js, /admin\/announcements/, '没有调公告接口');
  const wxml = read('packageAdmin/pages/announce/announce.wxml').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(/看过的人收不回来|收不回来/.test(js + wxml), '撤回没有说清「看过的人收不回」');
});
