/**
 * 守护「后端枚举 → 小程序中文文案」的完整性。
 *
 * 起因：账单列表页与详情页各自维护 STATUS_LABEL，列表页补了 REFUNDED
 * 详情页漏了，业主在详情页直接看到英文「REFUNDED」。
 * 此测试直接解析 packages/shared/src/enums.ts 的真实取值，
 * 与 apps/miniprogram/utils/labels.js 逐项比对，缺一项即失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const labels = require(path.join(ROOT, 'apps/miniprogram/utils/labels.js'));
const enumSrc = fs.readFileSync(path.join(ROOT, 'packages/shared/src/enums.ts'), 'utf8');

/** 从 enums.ts 里取出某个 export const 的字符串字面量数组（支持跨行书写） */
function backendEnum(name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`, 'm');
  const m = enumSrc.match(re);
  assert.ok(m, `enums.ts 里找不到 ${name}`);
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

/** name: 后端枚举名, map: 小程序文案表, allowMissing: 业主端确实无需展示的取值 */
const CASES = [
  { name: 'BILL_STATUSES', map: labels.BILL_STATUS },
  { name: 'PAYMENT_STATUSES', map: labels.PAYMENT_STATUS },
  { name: 'INVOICE_APPLICATION_STATUSES', map: labels.INVOICE_STATUS },
  { name: 'INVOICE_TITLE_TYPES', map: labels.INVOICE_TITLE_TYPE },
  { name: 'TICKET_TYPES', map: labels.TICKET_TYPE },
  { name: 'TICKET_STATUSES', map: labels.TICKET_STATUS },
  { name: 'PASS_STATUSES', map: labels.PASS_STATUS },
  { name: 'SERVICE_ORDER_STATUSES', map: labels.SERVICE_ORDER_STATUS },
  { name: 'COUPON_TYPES', map: labels.COUPON_TYPE },
  { name: 'USER_COUPON_STATUSES', map: labels.USER_COUPON_STATUS },
  { name: 'BINDING_RELATIONS', map: labels.BINDING_RELATION },
  { name: 'BINDING_SOURCES', map: labels.BINDING_SOURCE },
  { name: 'BINDING_STATUSES', map: labels.BINDING_STATUS },
  { name: 'METER_TYPES', map: labels.METER_TYPE },
  { name: 'SHARE_BY', map: labels.SHARE_BY },
  { name: 'HOUSE_TYPES', map: labels.HOUSE_TYPE },
];

for (const { name, map } of CASES) {
  test(`${name}：每个取值都有中文文案`, () => {
    const values = backendEnum(name);
    assert.ok(values.length > 0, `${name} 解析为空`);
    const missing = values.filter((v) => !map[v]);
    assert.deepEqual(
      missing,
      [],
      `${name} 缺少文案：${missing.join(', ')} —— 会把英文枚举显示给业主，请补到 utils/labels.js`,
    );
  });

  test(`${name}：文案表里没有后端已不存在的取值`, () => {
    const values = new Set(backendEnum(name));
    const stale = Object.keys(map).filter((k) => !values.has(k));
    assert.deepEqual(stale, [], `${name} 存在后端已删除的取值：${stale.join(', ')}`);
  });
}

test('label() 兜底不暴露内部代码', () => {
  assert.equal(labels.label(labels.BILL_STATUS, 'UNPAID'), '待缴');
  assert.equal(labels.label(labels.BILL_STATUS, 'SOMETHING_NEW'), '—');
  assert.equal(labels.label(labels.BILL_STATUS, null), '—');
  assert.equal(labels.label(labels.BILL_STATUS, undefined), '—');
  assert.equal(labels.label(labels.BILL_STATUS, ''), '—');
});

test('页面不应再各自定义 STATUS_LABEL（应统一取 utils/labels.js）', () => {
  const pagesDir = path.join(ROOT, 'apps/miniprogram/pages');
  const offenders = [];
  for (const dir of fs.readdirSync(pagesDir)) {
    const js = path.join(pagesDir, dir, `${dir}.js`);
    if (!fs.existsSync(js)) continue;
    const src = fs.readFileSync(js, 'utf8');
    // 只拦「状态」类映射：这类最容易漏枚举；类型/分类映射暂不强制
    if (/const\s+STATUS_LABEL\s*=\s*\{/.test(src)) offenders.push(`pages/${dir}/${dir}.js`);
  }
  assert.deepEqual(
    offenders,
    [],
    `以下页面仍自建 STATUS_LABEL，请改为从 utils/labels.js 取：\n  ${offenders.join('\n  ')}`,
  );
});
