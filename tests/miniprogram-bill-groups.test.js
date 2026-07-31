const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 账单页分组头部的数字必须是权威的。
 *
 * 缺陷经过：组头显示「2026-05 · 5 笔 · ¥X」，而这个和是按**已加载页**算的。
 * 列表按 `status asc, createdAt desc` 排序，不按账期，同一账期的账单散落在不同分页，
 * 所以那个数字只是一部分 —— 却长着权威数字的样子。业主问「5 月欠多少」会读到错数。
 *
 * 这类「看起来权威的错数」比缺一个数字危险得多：用户不会怀疑它。
 */

const SRC = path.join(__dirname, '..', 'apps', 'miniprogram', 'pages', 'bill');
const js = fs.readFileSync(path.join(SRC, 'bill.js'), 'utf8');
const wxml = fs.readFileSync(path.join(SRC, 'bill.wxml'), 'utf8');
/** 去掉注释，避免注释里提到某个写法就算「代码里有」——本仓踩过多次 */
const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** 从 `名字(参数) {` 起做真括号匹配，取出函数体。定长切片会切到下一个方法里去 */
function methodBody(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, `找不到 ${header}`);
  const open = src.indexOf('{', at + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`${header} 括号不匹配`);
}

test('组头小计取自权威接口而不是按已加载页求和', () => {
  assert.ok(code.includes('/owner/bills/by-period'), '必须请求 by-period 权威接口');

  /*
   * 断言的是「函数体内不得对条目金额做任何算术」，而不是某一种写法。
   * 第一版只禁了 `cents +=`，我用 reduce 改写同样的错误逻辑就绕过去了 ——
   * 守卫写得比缺陷具体，就只能抓到自己想到的那一种。
   */
  const body = methodBody(code, 'buildGroups(bills) {');
  assert.ok(/subtotal:\s*t \? Number\(t\.amount\)/.test(body), '小计必须来自权威值 t.amount');
  for (const [pattern, why] of [
    [/reduce\(/, 'reduce 累加'],
    [/\*\s*100/, '元转分的乘法'],
    [/\+=/, '累加赋值'],
    [/Number\(\s*b\.amount/, '读取条目金额'],
  ]) {
    assert.ok(!pattern.test(body), `buildGroups 体内不得出现${why}——列表不按账期排序，按已加载页求和一定偏小`);
  }
});

test('权威小计只在第一页请求一次', () => {
  // 翻页不改变筛选条件，小计不会变；每页都拉是白费请求
  assert.ok(/page === 1[\s\S]{0,160}by-period/.test(code), '应仅在 page === 1 时请求');
});

test('权威数字与列表用同一份查询串', () => {
  /*
   * 两处条件不一致会让组头笔数与列表对不上 ——「同一个量两处显示成两个数」
   * 比缺数字更难排查（本仓出过一次：收缴率两处不同）。
   */
  const m = /by-period\?\$\{(\w+)\}/.exec(code);
  assert.ok(m, 'by-period 应复用查询串变量');
  assert.ok(
    new RegExp(`/owner/bills\\?\\$\\{${m[1]}\\}`).test(code),
    `列表与 by-period 必须都用 ${m ? m[1] : '?'}`,
  );
});

test('拿不到权威数字时不显示小计，只说已加载多少', () => {
  // 宁可少一个数字，也不能显示一个看起来权威的错数——这是钱
  assert.ok(/partial:\s*!t/.test(code), '需要标记降级状态');
  assert.ok(wxml.includes('wx:if="{{!group.partial}}"'), '降级时不得渲染小计');
  assert.ok(/已加载\s*\{\{group.count\}\}\s*笔/.test(wxml), '降级文案要说明这是已加载的笔数');
});

test('by-period 请求失败不能让整页崩掉', () => {
  // 小计是附加信息，账单列表本身必须照常显示
  assert.ok(/by-period[\s\S]{0,160}catch\(\(\)\s*=>\s*null\)/.test(code), '需静默降级');
  assert.ok(/by-period[\s\S]{0,120}silent:\s*true/.test(code), '失败不该弹全局错误提示');
});

test('组头笔数优先用权威值', () => {
  // 笔数和金额必须同源，否则会出现「3 笔 · ¥1234.56」这种自相矛盾的组头
  assert.ok(/count:\s*t \? t\.count/.test(code), '笔数也要取权威值');
  assert.ok(/subtotal:\s*t \?/.test(code), '金额取权威值');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✕ ${name}\n    ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
