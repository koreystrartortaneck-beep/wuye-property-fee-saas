const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 2026-08-02：业主第二次指出「这个搜索按钮没必要那么大」。
 * 第一次我改了 `width: auto`，第二次他发来的截图和第一次一模一样。
 *
 * 查下来根因不在那条规则，而在元素本身：
 *
 *   · <button> 自带一整套我们控制不了的默认样式。
 *     同一屏上「重新匹配名下房屋」写着 width: 100%，真机上却只有半屏宽、居中飘着 ——
 *     两颗按钮同时不听 CSS，说明问题不是某一条声明写错了。
 *   · 而我用来自查的截图工具把 <button> 映射成 <div>，
 *     于是它渲染出来永远是「已修好」的样子。工具第 5 次给出假结论。
 *
 * 结论：<button> 只在**需要 open-type**（授权手机号、隐私协议）时才是必需的。
 * 其余一律用 <view> —— 尺寸就完全由我们的 CSS 决定，不再受端上默认样式摆布。
 *
 * 这个文件钉两件事：
 *   ① 已经改好的地方不许退回去
 *   ② 还没改的地方数量只能减不能增（下面那份清单就是待还的债）
 */

const ROOT = path.resolve(__dirname, '..');
const MP = path.join(ROOT, 'apps/miniprogram');

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

function allWxml(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allWxml(p, out);
    else if (e.name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

/** 返回 [{file, tag, needsOpenType}] */
function buttons() {
  const found = [];
  for (const file of allWxml(MP)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/<button\b[^>]*>/gs)) {
      found.push({
        file: path.relative(MP, file),
        tag: m[0].replace(/\s+/g, ' '),
        needsOpenType: m[0].includes('open-type='),
      });
    }
  }
  return found;
}

/*
 * 待还的债：这些 <button> 还没换成 view。
 *
 * 没有一次性全改，是因为其中 8 个用了 button 自带的 loading / disabled，
 * 换成 view 要连交互状态一起重做，而它们分布在 20 个文件里 ——
 * 在业主正拿真机测的时候一次性动 37 处，风险比那颗大按钮本身更大。
 *
 * 这份清单存在的意义是让它**不会被忘掉**：数字只能往下走。
 */
const KNOWN_DEBT = 37;

test('需要授权的地方仍然用 <button> —— 这是 view 替代不了的', () => {
  /*
   * 反向也要钉住：open-type 的能力只有 button 有。
   * 若有人为了统一样式把它们也改成 view，授权功能会静默失效 ——
   * 点了没反应，而代码里看不出任何错。
   */
  const authButtons = buttons().filter((b) => b.needsOpenType);
  const types = authButtons.map((b) => /open-type="([^"]+)"/.exec(b.tag)?.[1]).sort();
  assert.deepEqual(
    types,
    ['agreePrivacyAuthorization', 'getPhoneNumber', 'getPhoneNumber'],
    '授权按钮的集合变了：要么有人把 button 改成了 view（授权会静默失效），要么新增了未登记的授权点',
  );
});

test('已经改好的三处不许退回 <button>', () => {
  const cases = [
    ['pages/bind-house/bind-house.wxml', 'inline-btn', '绑定房屋页的「匹配」'],
    ['pages/bill/bill.wxml', 'bill-pay-btn', '账单行里的「缴费」'],
    ['pages/services/services.wxml', 'svc-btn', '服务卡片里的「预约」'],
  ];
  for (const [file, cls, why] of cases) {
    const src = stripComments(fs.readFileSync(path.join(MP, file), 'utf8'));
    const tag = new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${cls}\\b`).exec(src);
    assert.ok(tag, `${why}：找不到 .${cls}`);
    assert.equal(tag[1], 'view', `${why}（.${cls}）又变回 <button> 了`);
  }
});

test('绑定房屋页的搜索按钮已经彻底删掉——不是改小，是不该存在', () => {
  /*
   * 输入即搜之后就不需要这颗按钮了。
   * 只把它改小仍然是「输入框旁边挂一颗金色胶囊」，业主说的「不协调」还在。
   */
  const src = stripComments(fs.readFileSync(path.join(MP, 'pages/bind-house/bind-house.wxml'), 'utf8'));
  assert.ok(!/>\s*搜索\s*</.test(src), '搜索按钮又回来了');
  assert.match(src, /bindinput="onKeywordInput"/, '没有输入即搜');
});

test('授权按钮靠父容器的 flex 撑开，不靠 width: 100%', () => {
  /*
   * 这是 open-type 那颗唯一能用的办法：
   * 它必须是 <button>，而 <button> 在真机上不听 width: 100%（实测半屏宽、居中）。
   * 父容器 display:flex + 自身 flex:1 是确定的 —— 没有多余空间可分，
   * button 自带的左右 auto 外边距也就无处可去。
   */
  const wxml = stripComments(fs.readFileSync(path.join(MP, 'pages/bind-house/bind-house.wxml'), 'utf8'));
  assert.match(wxml, /class="btn-row"[\s\S]{0,200}?<button[^>]*btn-fill/, '授权按钮没有包在 .btn-row 里');

  const wxss = fs.readFileSync(path.join(MP, 'pages/bind-house/bind-house.wxss'), 'utf8');
  const rule = (c) => new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`).exec(wxss)?.[1] ?? '';
  assert.match(rule('btn-row'), /display:\s*flex/, '.btn-row 不是 flex 容器');
  assert.match(rule('btn-fill'), /flex:\s*1/, '.btn-fill 没有 flex: 1，又退回靠 width 撑');
});

test('剩余未改造的 <button> 只减不增', () => {
  const plain = buttons().filter((b) => !b.needsOpenType);
  assert.ok(
    plain.length <= KNOWN_DEBT,
    `未改造的 <button> 从 ${KNOWN_DEBT} 涨到了 ${plain.length}：\n` +
      plain.map((b) => `  ${b.file}  ${b.tag.slice(0, 90)}`).join('\n'),
  );
  // 改少了就把上面的数字调下来，否则这条守卫会越来越松
  assert.ok(
    plain.length >= KNOWN_DEBT,
    `已经改到 ${plain.length} 个了，请把 KNOWN_DEBT 从 ${KNOWN_DEBT} 改成 ${plain.length}`,
  );
});
