const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'packages', 'shared', 'src', 'enum-labels.ts');
const MINI_LABELS = path.join(ROOT, 'apps', 'miniprogram', 'utils', 'labels.js');
const ADMIN = path.join(ROOT, 'apps', 'admin', 'src');

/**
 * 同一个枚举取值，三端必须是同一个中文词。
 *
 * 此前没有任何测试能发现这类漂移：tests/miniprogram-labels.test.js 只校验
 * 「enums.ts 的 key 在 labels.js 里有没有对应文案」，从不比对**中文是否相同**。
 * 于是后台与小程序在 7 个 key 上分化：
 *   BillStatus.DRAFT                后台「草稿」   / 小程序「未发布」
 *   InvoiceStatus.REVERSAL_REQUIRED 后台「需红冲」 / 小程序「待红冲」
 *   PassStatus.USED                 后台「已核销」 / 小程序「已使用」
 *   CouponType.DISCOUNT             后台「满减抵扣」/ 小程序「满减」
 *   WorkCategory.INSPECTION         后台「日常巡检」/ 小程序「巡检」「日常巡检」两种
 *   WorkCategory.OTHER              后台「其他」   / 小程序「公示」「其他」两种
 *   ServiceOrderStatus.PENDING      小程序真源表「待受理」/ 实际渲染「待接单」
 * 后果是业主打电话说「我那张显示已使用」，员工在后台看到的是「已核销」，
 * 要在脑子里做一次翻译；WorkCategory 更糟——业主在列表看到「巡检」，点进详情
 * 变成「日常巡检」，一次点击之内换了名字。
 *
 * 后台前端目前没有接 packages/shared（接进去要改 Vite 别名，有构建风险），
 * 所以三份中文各自维护，由本测试强制一致。
 */

/** 从 TS/JS 源码里解析一张 `X = { A: '中', B: '文' }` 形式的映射表 */
function parseMap(src, name) {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 支持 `const X = {`、`export const X: Record<string,string> = {`
  const re = new RegExp(`\\b${name}\\b[^={]*=\\s*\\{`);
  const m = re.exec(stripped);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = stripped.indexOf('}', start);
  if (end === -1) return null;
  const body = stripped.slice(start, end);
  const out = {};
  for (const kv of body.matchAll(/([A-Z_][A-Z0-9_]*)\s*:\s*'([^']*)'/g)) out[kv[1]] = kv[2];
  return Object.keys(out).length ? out : null;
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function adminFile(rel) {
  return read(path.join(ADMIN, rel));
}

const sharedSrc = read(SHARED);
const miniSrc = read(MINI_LABELS);

/**
 * 三端映射表的对应关系。
 * admin 一列是 [文件, 表名]；null 表示后台没有这张表（不参与比对）。
 */
const PAIRS = [
  { concept: '账单状态', shared: 'BILL_STATUS_CN', mini: 'BILL_STATUS', admin: ['finance.ts', 'BILL_STATUS_LABEL'] },
  { concept: '支付状态', shared: 'PAYMENT_STATUS_CN', mini: 'PAYMENT_STATUS', admin: ['finance.ts', 'PAYMENT_STATUS_LABEL'] },
  { concept: '发票状态', shared: 'INVOICE_STATUS_CN', mini: 'INVOICE_STATUS', admin: ['finance.ts', 'INVOICE_STATUS_LABEL'] },
  { concept: '通行码状态', shared: 'PASS_STATUS_CN', mini: 'PASS_STATUS', admin: ['views/VisitorPasses.vue', 'STATUS'] },
  { concept: '我的券状态', shared: 'USER_COUPON_STATUS_CN', mini: 'USER_COUPON_STATUS', admin: null },
  { concept: '工作分类', shared: 'WORK_CATEGORY_CN', mini: 'WORK_CATEGORY', admin: ['composables.ts', 'WORK_CATEGORY_LABEL'] },
  { concept: '服务单状态', shared: 'SERVICE_ORDER_STATUS_CN', mini: 'SERVICE_ORDER_STATUS', admin: ['composables.ts', 'SERVICE_ORDER_STATUS_LABEL'] },
];

test('shared 的中文映射表都能被解析到（表被改名会让后续断言全部空转）', () => {
  for (const p of PAIRS) {
    const m = parseMap(sharedSrc, p.shared);
    assert.ok(m, `packages/shared 里找不到 ${p.shared}——被改名了？请同步更新本测试`);
    assert.ok(Object.keys(m).length >= 2, `${p.shared} 只解析出 ${Object.keys(m ?? {}).length} 项，正则可能失效`);
  }
});

test('小程序与 shared：同 key 同中文', () => {
  const bad = [];
  for (const p of PAIRS) {
    const s = parseMap(sharedSrc, p.shared);
    const m = parseMap(miniSrc, p.mini);
    if (!m) {
      bad.push(`labels.js 里找不到 ${p.mini}（${p.concept}）`);
      continue;
    }
    for (const [k, v] of Object.entries(m)) {
      if (s[k] === undefined) continue; // 小程序可以多几个取值（如 COUPON_TYPE.SERVICE）
      if (s[k] !== v) bad.push(`${p.concept}.${k}：shared「${s[k]}」≠ 小程序「${v}」`);
    }
  }
  assert.deepStrictEqual(bad, [], '\n  ' + bad.join('\n  '));
});

test('后台与 shared：同 key 同中文', () => {
  const bad = [];
  for (const p of PAIRS) {
    if (!p.admin) continue;
    const [file, name] = p.admin;
    const a = parseMap(adminFile(file), name);
    if (!a) {
      bad.push(`${file} 里找不到 ${name}（${p.concept}）——被改名了？请同步更新本测试`);
      continue;
    }
    const s = parseMap(sharedSrc, p.shared);
    for (const [k, v] of Object.entries(a)) {
      if (s[k] === undefined) continue;
      if (s[k] !== v) bad.push(`${p.concept}.${k}：shared「${s[k]}」≠ 后台「${v}」（${file}）`);
    }
  }
  assert.deepStrictEqual(bad, [], '\n  ' + bad.join('\n  '));
});

test('同一个 key 在小程序内部不得有两种译法', () => {
  /*
   * 原状：PASS_STATUS.USED 是「已使用」，USER_COUPON_STATUS.USED 是「已核销」,
   * 同一个文件里同一个 key 两种译法。这里只查语义确实相同的那几个 key，
   * 不搞全局唯一——PENDING 在工单是「待受理」、在服务单是「待接单」，
   * 那是刻意区分（物业接单 ≠ 受理工单），不能强制统一。
   */
  /*
   * CANCELED 刻意不在此列：账单的 CANCELED 是「物业把这张账单作废了」，
   * 通行码的 CANCELED 是「业主自己取消了预约」，中文本就该不同
   * （「已作废」/「已取消」）。本测试第一版把它算作同义 key，于是把一处正确的
   * 区分报成了漂移。
   */
  const SAME_MEANING = ['USED', 'EXPIRED'];
  const maps = ['PASS_STATUS', 'USER_COUPON_STATUS', 'BILL_STATUS', 'PAYMENT_STATUS'];
  const seen = {};
  const bad = [];
  for (const name of maps) {
    const m = parseMap(miniSrc, name);
    if (!m) continue;
    for (const k of SAME_MEANING) {
      if (m[k] === undefined) continue;
      if (seen[k] && seen[k].v !== m[k]) {
        bad.push(`${k}：${seen[k].name}「${seen[k].v}」≠ ${name}「${m[k]}」`);
      }
      seen[k] = { name, v: m[k] };
    }
  }
  assert.deepStrictEqual(bad, [], '\n  ' + bad.join('\n  '));
});

test('业主端不得出现内部术语', () => {
  /*
   * 「红冲」是会计术语，而 REVERSAL_REQUIRED 这个状态是业主退款成功后由系统自动置上的
   * （invoice.service.ts），业主必然会看到。「核销」是财务/门岗术语。
   */
  const FORBIDDEN = ['红冲', '核销', '幂等', '租户'];
  const bad = [];
  /*
   * 必须剥注释。本测试第一版直接在整份源码上 includes()，而我为了说明「核销是
   * 财务术语、所以换成已使用」在 labels.js 里写了这句注释——守卫立刻命中自己的
   * 说明文字。「注释被当成代码」这一类错误本会话已第五次出现。
   */
  const miniCode = miniSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of FORBIDDEN) {
    if (miniCode.includes(word)) bad.push(`labels.js 含内部术语「${word}」`);
    if (parseMap(sharedSrc, 'INVOICE_STATUS_CN') && Object.values(parseMap(sharedSrc, 'INVOICE_STATUS_CN')).some((v) => v.includes(word))) {
      bad.push(`shared 的发票状态含内部术语「${word}」`);
    }
  }
  assert.deepStrictEqual(bad, [], '\n  ' + bad.join('\n  '));
});

test('页面不得自建枚举中文映射（真源只能在 labels.js）', () => {
  /*
   * WorkCategory 曾在 4 个页面各写一份并互相矛盾。原有的
   * tests/miniprogram-labels.test.js 只按字面量名 `STATUS_LABEL` 匹配，
   * 于是 ORDER_STATUS / WORK_CAT / CATEGORY_LABEL / RELATION_LABEL 全部绕过。
   * 这里改为按**形状**判定：任何「全大写 key → 中文字符串」的对象字面量都算真源，
   * 与它叫什么名字无关。
   */
  /*
   * 例外：不是枚举文案的表。
   * 判定按「全大写 key → 中文」的形状，会连带命中这类「按枚举取值给的界面文案」——
   * 它们本就是页面专属的，不该塞进 labels.js。
   */
  const NOT_A_LABEL_MAP = {
    'pages/ticket-create/ticket-create.js:PLACEHOLDER': '按工单类型给的输入框提示语，是本页文案不是状态文案',
  };
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs
          .readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        // const X = { UPPER: '中文', UPPER: '中文', ... } —— 至少两个大写 key 才算映射表
        for (const m of src.matchAll(/const\s+(\w+)\s*=\s*\{([^}]*)\}/g)) {
          const entries = [...m[2].matchAll(/([A-Z_][A-Z0-9_]*)\s*:\s*'[^']*[一-龥][^']*'/g)];
          if (entries.length < 2) continue;
          const rel = path.relative(path.join(ROOT, 'apps', 'miniprogram'), p);
          if (`${rel}:${m[1]}` in NOT_A_LABEL_MAP) continue;
          offenders.push(`${rel} → const ${m[1]}（${entries.length} 项，含 ${entries[0][1]}）`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'apps', 'miniprogram', 'pages'));
  if (offenders.length) {
    throw new Error(
      '以下页面自建了枚举中文映射，会与 utils/labels.js 分化（业主在列表和详情看到不同的词）：\n  ' +
        offenders.join('\n  ') +
        '\n请把文案加到 utils/labels.js 并 require 过来。',
    );
  }
});

test('后台：同一个概念不得在两个文件里各有一份', () => {
  /*
   * 缺陷经过：绑定关系、绑定状态、工单类型、工单状态这四张表各在两个页面里重复
   * （Bindings.vue / HouseProfile.vue / Tickets.vue 之间）。
   * 取值当时恰好一致，所以既有的一致性测试查不出来 —— 它只对比「列进 PAIRS 的那几张表」。
   *
   * 为什么不像小程序侧那样宽泛地禁掉一切页面内映射：
   * Operations.vue 的 CHECK_LABEL、BillRun.vue 的 SKIP_REASON 之类**本就是本页专属**，
   * 硬塞进公共文件反而更糟，还会催生一张越来越长的例外清单。
   * 真正要防的风险是「两份拷贝各自演进」，所以直接钉这一点。
   *
   * 概念身份用**键集合完全相同**判定：{OWNER,TENANT,FAMILY} 出现两次就是同一概念。
   * 用「有交集」会误报 —— PENDING 在工单与绑定里都有，含义并不同。
   */
  const dir = path.join(ROOT, 'apps', 'admin', 'src');
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p2 = path.join(d, e.name);
      if (e.isDirectory()) walk(p2);
      else if (/\.(ts|vue)$/.test(e.name) && !e.name.includes('.spec.')) {
        const src = fs
          .readFileSync(p2, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        for (const m of src.matchAll(/const\s+(\w+)\s*(?::[^=]*)?=\s*\{([^}]*)\}/g)) {
          const entries = [...m[2].matchAll(/([A-Z_][A-Z0-9_]*)\s*:\s*'([^']*)'/g)].filter((x) =>
            /[一-龥]/.test(x[2]),
          );
          if (entries.length < 2) continue;
          found.push({
            file: path.relative(dir, p2),
            name: m[1],
            sig: entries.map((x) => x[1]).sort().join(','),
            values: Object.fromEntries(entries.map((x) => [x[1], x[2]])),
          });
        }
      }
    }
  };
  walk(dir);

  // 先自检：解析器必须真的找到一批表，否则下面那条断言永真
  assert.ok(found.length >= 10, `只解析到 ${found.length} 张映射表，解析器可能坏了`);

  const dupes = findDuplicateConcepts(found);
  assert.deepStrictEqual(dupes, [], '\n  ' + dupes.join('\n  '));
});

/**
 * 检测「同一键集合出现在多个文件」。抽成函数是为了能用合成数据反向验证它自己 ——
 * 否则一行 `continue` 就能把整条守卫悄悄关掉，而测试仍然全绿
 * （我注入验证时正是这么绕过去的）。
 */
function findDuplicateConcepts(found) {
  const bySig = {};
  for (const f of found) (bySig[f.sig] ||= []).push(f);
  const dupes = [];
  for (const [sig, list] of Object.entries(bySig)) {
    const files = [...new Set(list.map((x) => x.file))];
    if (files.length < 2) continue;
    // 取值是否已经漂移一并报出：已漂移的属于线上可见缺陷，不只是隐患
    const drifted = [];
    for (const k of sig.split(',')) {
      const vals = [...new Set(list.map((x) => x.values[k]))];
      if (vals.length > 1) drifted.push(`${k}: ${vals.join(' \u2260 ')}`);
    }
    dupes.push(
      `{${sig}} 在 ${files.join(' 与 ')} 各有一份` + (drifted.length ? `，且已漂移：${drifted.join('；')}` : ''),
    );
  }
  return dupes;
}

test('重复检测器本身能认出重复与漂移（正向对照）', () => {
  // 同键集合、同取值 → 必须报重复
  const same = [
    { file: 'a.ts', name: 'X', sig: 'A,B', values: { A: '甲', B: '乙' } },
    { file: 'b.vue', name: 'Y', sig: 'A,B', values: { A: '甲', B: '乙' } },
  ];
  const r1 = findDuplicateConcepts(same);
  assert.strictEqual(r1.length, 1, '同键集合出现在两个文件必须被报出来');
  assert.ok(!r1[0].includes('漂移'), '取值一致时不该报漂移');

  // 同键集合、取值不同 → 还要指出漂移的是哪个 key
  const drift = [
    { file: 'a.ts', name: 'X', sig: 'A,B', values: { A: '甲', B: '乙' } },
    { file: 'b.vue', name: 'Y', sig: 'A,B', values: { A: '甲', B: '丙' } },
  ];
  const r2 = findDuplicateConcepts(drift);
  assert.strictEqual(r2.length, 1);
  assert.ok(r2[0].includes('漂移') && r2[0].includes('B:'), `应指出漂移的 key，实际：${r2[0]}`);

  // 同一文件里两张同形表不算重复（不是跨文件拷贝，改的时候一眼能看见）
  const oneFile = [
    { file: 'a.ts', name: 'X', sig: 'A,B', values: { A: '甲', B: '乙' } },
    { file: 'a.ts', name: 'Y', sig: 'A,B', values: { A: '甲', B: '乙' } },
  ];
  assert.deepStrictEqual(findDuplicateConcepts(oneFile), []);

  // 键集合不同（仅有交集）不算同一概念：PENDING 在工单与绑定里含义不同
  const overlap = [
    { file: 'a.ts', name: 'X', sig: 'ACTIVE,PENDING', values: { ACTIVE: '已通过', PENDING: '待审核' } },
    { file: 'b.vue', name: 'Y', sig: 'DONE,PENDING', values: { DONE: '已办结', PENDING: '待受理' } },
  ];
  assert.deepStrictEqual(findDuplicateConcepts(overlap), []);
});
