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
