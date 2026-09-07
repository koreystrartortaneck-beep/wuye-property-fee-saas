const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../apps/miniprogram');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('保留改造前 a37e5fc 的整套管理端基础样式，新增布局不覆盖原组件', () => {
  const css = read('packageAdmin/adm.wxss');
  const [original, additions] = css.split('/* 新增功能沿用原管理端视觉，只补分页、筛选与固定操作布局。 */');
  assert.equal(crypto.createHash('sha256').update(original.trimEnd()).digest('hex'),
    '4ee40fee037a5294e5bc546c0741cc020fc20933e8700b743d4faeceb5fec9a3');
  assert.ok(additions);
  assert.doesNotMatch(additions, /\.adm-page\s+\.(?:adm-card|adm-btn|tab|hero|sum-card)\b/);
  assert.match(additions, /\.adm-dock\s*\{[^}]*position:\s*fixed/s);
});

test('楼盘格子恢复原单元卡和状态图例，不使用新版绿橙底色', () => {
  const css = read('packageAdmin/pages/home/home.wxss');
  const wxml = read('packageAdmin/pages/home/home.wxml');
  assert.match(wxml, /class="unit-card"/);
  assert.match(wxml, /class="dot dot-r"/);
  assert.match(wxml, /class="dot dot-g"/);
  assert.doesNotMatch(css, /#edf2ed|#f6e9e1|#34263f/);
  assert.doesNotMatch(wxml, /绿色：无欠费|\{\{u.unit\}\}单元/);
  assert.match(wxml, /bindtap="goReceipts"/);
});

test('固定主操作保留胶囊圆角与安全区，不再贴边改成方形按钮', () => {
  for (const name of ['announce', 'bill-one', 'billing', 'collect', 'coupon-new', 'coupon-verify', 'house-new', 'staff', 'receipt']) {
    const css = read(`packageAdmin/pages/${name}/${name}.wxss`);
    assert.doesNotMatch(css, /border-radius:\s*0\s*[;}]/, name);
    assert.match(css, /bottom:\s*calc\(24rpx \+ env\(safe-area-inset-bottom\)\)/, name);
  }
});

test('欠费金额卡不占用吸顶区，筛选及跨页全选仍保留', () => {
  const wxml = read('packageAdmin/components/arrears-panel/index.wxml');
  assert.ok(wxml.indexOf('class="sum-card"') < wxml.indexOf('class="adm-sticky"'));
  assert.doesNotMatch(read('packageAdmin/components/arrears-panel/index.wxss'), /\.adm-sticky \.sum-card/);
  assert.match(wxml, /全部勾选/);
  assert.match(wxml, /hidden="\{\{!active\}\}"/);
});
