const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 业主问：「如果有一两百户，好几个小区之后，这个怎么提交绑定？怎么显示内容？」
 *
 * 原来的做法是：选完小区，把整个小区的房号铺成一片圆角标签。
 * 三户的时候看起来挺好，213 户的时候：
 *   · 213 个标签，滚好几屏，找自己家全靠肉眼扫
 *   · 而后端只给前 100 条，第 101 户往后的人根本翻不到，界面什么都不说
 *
 * 改成「输入房号即搜 + 列表 + 说出总数」。这个文件钉住不许退回去。
 */

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'apps/miniprogram');
const readWxml = (p) => fs.readFileSync(path.join(MP, p), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const js = fs.readFileSync(path.join(MP, 'pages/bind-house/bind-house.js'), 'utf8');
const wxml = readWxml('pages/bind-house/bind-house.wxml');

/** 取方法体：靠名字直接 indexOf 会命中调用点而不是定义 */
function methodBody(src, name) {
  const at = src.search(new RegExp(`\\n\\s*(?:async\\s+)?${name}\\s*\\(`));
  assert.ok(at > 0, `找不到方法 ${name}`);
  const open = src.indexOf('{\n', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 的大括号没配平`);
}

test('房号不再铺成标签墙——213 户时那是滚不完的', () => {
  assert.ok(!wxml.includes('house-grid'), '房号标签墙还在');
  assert.match(wxml, /bindinput="onHouseKeywordInput"/, '没有房号搜索框');
});

test('房号搜索把关键词发给后端，而不是在本地过滤前 20 条', () => {
  /*
   * 本地过滤是个很容易犯的错：看起来能搜，但被搜的只是已经拿到的那 20 条 ——
   * 第 101 户的业主搜自己家，永远是「没找到」。
   */
  const body = methodBody(js, 'searchHouses');
  assert.match(body, /keyword=\$\{encodeURIComponent/, '房号关键词没有发给后端');
  assert.match(body, /\/owner\/communities\/\$\{[^}]+\}\/houses/, '请求路径不对');
});

test('两个搜索都防抖，且只认最后一次的结果', () => {
  /*
   * 不防抖 = 每敲一个字发一次请求。
   * 而更隐蔽的是乱序：先发的请求后到，会把新关键词的结果覆盖掉，
   * 屏幕上显示的列表和输入框里的字对不上。ticket 递增就是防这个。
   */
  assert.match(js, /DEBOUNCE_MS\s*=\s*(\d+)/, '防抖间隔应提为具名常量');
  const ms = Number(/DEBOUNCE_MS\s*=\s*(\d+)/.exec(js)[1]);
  assert.ok(ms >= 150 && ms <= 600, `防抖 ${ms}ms 不在合理区间`);

  for (const name of ['searchCommunities', 'searchHouses']) {
    const body = methodBody(js, name);
    assert.match(body, /\+\+this\._\w+Ticket/, `${name} 没有请求序号`);
    assert.match(body, /if \(ticket !== this\._\w+Ticket\) return/, `${name} 没有丢弃过期结果`);
  }
});

test('被截断时必须说出来——不说的话业主会以为物业没登记他家', () => {
  assert.match(wxml, /houseMore > 0/, '房号截断没有提示');
  assert.match(wxml, /communityMore > 0/, '小区截断没有提示');
  assert.match(wxml, /houseTotal/, '提示里没有给出总数');
  // 光说「还有更多」没用，得告诉他怎么办
  assert.ok(/请输入房号缩小范围/.test(wxml), '没有告诉业主下一步该做什么');
});

test('选错小区能退回去重选', () => {
  /*
   * 原来选中小区之后，小区列表整个消失，没有任何返回入口 ——
   * 点错一下就只能退出页面重进。
   */
  assert.match(wxml, /bindtap="resetCommunity"/, '没有「更换小区」入口');
  const body = methodBody(js, 'resetCommunity');
  assert.match(body, /selectedCommunity: null/, '没有清空已选小区');
  assert.match(body, /selectedHouse: null/, '换小区时没有清掉上一个小区选中的房号');
});

test('换小区时房号必须一起清掉——否则会拿着 A 小区的房号提交给 B 小区', () => {
  const body = methodBody(js, 'pickCommunity');
  assert.match(body, /selectedHouse: null/, 'pickCommunity 没有清空已选房号');
});

test('搜索中 / 无结果 / 空关键词，三种状态都有话说', () => {
  /*
   * 少任何一种，界面就会有一段时间是空白的 ——
   * 而空白在业主看来等同于「坏了」。
   */
  assert.match(wxml, /houseSearching/, '房号搜索没有加载态');
  assert.match(wxml, /searching/, '小区搜索没有加载态');
  assert.ok(/没有找到/.test(wxml), '没有无结果文案');
});

test('页面卸载时清掉定时器', () => {
  // 否则页面已经销毁，防抖回调还会 setData 上去
  const body = methodBody(js, 'onUnload');
  assert.match(body, /clearTimeout/, 'onUnload 没有清定时器');
});

test('后端返回旧结构（数组）也能用——小程序和 API 不同时上线', () => {
  /*
   * 2026-08-02 实测撞上的空窗：
   * 开发者工具点一下编译是立刻生效的，而 API 走云托管要 6–10 分钟。
   * 那段时间里新小程序连的是旧 API。
   *
   * 原来写的是 `res.items || []`：旧 API 返回数组，res.items 是 undefined，
   * 被悄悄变成空数组 —— 界面于是斩钉截铁地说「没有找到「金港城」」，
   * 而那个小区就在库里。
   */
  const src = fs.readFileSync(path.join(MP, 'pages/bind-house/bind-house.js'), 'utf8');
  const fn = /function normalizeList[\s\S]*?\n}/.exec(src);
  assert.ok(fn, '没有归一化函数，两种结构不可能都认');
  // eslint-disable-next-line no-new-func
  const normalizeList = new Function(`${fn[0]}; return normalizeList;`)();

  assert.deepEqual(normalizeList([{ id: 'a' }]), { items: [{ id: 'a' }], total: 1 }, '不认旧的数组结构');
  assert.deepEqual(
    normalizeList({ items: [{ id: 'a' }], total: 213 }),
    { items: [{ id: 'a' }], total: 213 },
    '不认新的 { items, total } 结构',
  );
  assert.equal(normalizeList({ oops: 1 }), null, '认不出的结构必须返回 null，不能当成空列表');
  assert.equal(normalizeList(null), null);
  assert.equal(normalizeList(undefined), null);
});

test('请求失败与「没搜到」必须是两句话', () => {
  /*
   * 这是这个项目里反复出现的同一类错误：把「我不知道」显示成「没有」。
   * 假消息比报错难查得多 —— 报错会让人来问，假消息会让人相信。
   */
  const src = fs.readFileSync(path.join(MP, 'pages/bind-house/bind-house.js'), 'utf8');
  for (const [name, flag] of [['searchCommunities', 'communityError'], ['searchHouses', 'houseError']]) {
    const body = methodBody(src, name);
    assert.match(body, new RegExp(`${flag}: true`), `${name} 失败时没有置错误态`);
    assert.match(body, /if \(!list\) throw/, `${name} 对读不懂的返回没有当成失败`);
  }
  assert.match(wxml, /communityError/, '小区列表没有失败态文案');
  assert.match(wxml, /houseError/, '房号列表没有失败态文案');
  assert.ok(/加载失败/.test(wxml), '失败文案没有说「失败」');
  // 光说失败不给出口，业主唯一能做的就是反复改关键词
  assert.match(wxml, /list-hint-error" bindtap="search/, '失败态不可点重试');
});

test('没输入就不铺列表——200 套里的前 20 套几乎必然不是他家', () => {
  /*
   * 业主实测指出的：选完小区直接铺 20 行，
   * 而这 20 行唯一的作用是把姓名、与房屋关系、提交按钮顶出屏幕。
   */
  assert.match(
    wxml,
    /scroll-view[^>]*wx:if="\{\{houses\.length > 0 && \(houseKeyword \|\| houseListOpen\)\}\}"/,
    '列表在没有输入、也没点「查看全部」时仍然会铺出来',
  );
  // 截断提示同理：列表都没显示，说「只显示了前 20 套」是自相矛盾的
  assert.match(wxml, /houseMore > 0 && \(houseKeyword \|\| houseListOpen\)/, '截断提示没跟着列表一起隐藏');
});

test('户数少的小区给「查看全部」，不逼人盲打房号', () => {
  /*
   * 一共 3 套的小区，新业主未必记得该写「1-101」还是「101」还是「1栋101」。
   * 看一眼列表比猜格式快得多 —— 但仍然要他主动点一下，规则才一致。
   */
  assert.match(wxml, /bindtap="openHouseList"/, '没有「查看全部」入口');
  assert.match(wxml, /houseMore > 0[\s\S]{0,120}请输入房号查找/, '大小区没有引导去搜索');
  const body = methodBody(js, 'openHouseList');
  assert.match(body, /houseListOpen: true/, 'openHouseList 没有打开列表');
});

test('换小区时「已展开」要归位', () => {
  /*
   * 否则在 12 套的小区点开过之后，换到 200 套的小区会直接又铺一屏 ——
   * 而这正是要避免的那一幕。
   */
  for (const name of ['pickCommunity', 'resetCommunity']) {
    assert.match(methodBody(js, name), /houseListOpen: false/, `${name} 没有把展开状态归位`);
  }
});

test('房号输入框的例子必须是真能搜到的写法', () => {
  /*
   * 占位符是唯一告诉业主「该怎么写」的地方。
   * 举一个搜不出来的例子，比不举更糟 —— 他会照着抄，然后得到 0 条，
   * 而在这个界面上 0 条的含义是「物业没登记我家」。
   *
   * 后端现在的行为：先整串匹配，不中再按分隔符/量词拆词 AND。
   * 下面这三种写法都在 house-picker-scale.spec.ts 里逐条验过。
   */
  const ph = /placeholder="([^"]*房号[^"]*)"/.exec(wxml)?.[1] ?? '';
  assert.ok(ph, '房号输入框没有占位提示');
  for (const form of ['1栋101', '1-101', '101']) {
    assert.ok(ph.includes(form), `占位符没给出「${form}」这种写法`);
  }
});
