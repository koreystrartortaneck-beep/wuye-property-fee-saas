/**
 * 把 WXML + WXSS 渲染成 HTML，用无头 Chrome 截图，**在没有微信开发者工具的情况下看界面**。
 *
 * 为什么需要：小程序有 24 个页面，而看不到界面就只能靠读代码猜排版。
 * 本轮用它逐页看下来，找出 13 处业主看得见的缺陷（账单页显示 ¥0.00、
 * 缴费确认页最大的数字是券前金额、收据明细对不上账、券显示成「¥券」、
 * 卡片高度不齐、动态日期列左右跳、绑定第一步认不出可点……）。
 *
 * 用法：
 *   node tools/wxml-preview.mjs <page.wxml> <page.wxss> <app.wxss> <data.json> <out.html> <标题>
 *   然后用 Chrome 截图（375pt 宽）：
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --disable-gpu --hide-scrollbars --window-size=375,900 \
 *     --screenshot=out.png --default-background-color=FFFFFFFF "file://$PWD/out.html"
 *
 * ── 保真度：它是近似，不是真机 ──
 *
 * rpx 按 1rpx = 0.5px 换算（375pt 宽）。WXSS 本身就是标准 CSS，所以颜色、间距、
 * flex 布局、字号这些是可信的；而它**骗过我三次**，每次都差点让我把工具的毛病
 * 当成产品缺陷。这三条写在这里，是因为下一个用它的人一定会再撞上：
 *
 *   1) 标签解析必须引号感知。属性值里有 `>` 很常见（wx:if="{{item.count > 1}}"），
 *      早期版本用 `[^>]*?` 匹配属性，会在表达式里的 `>` 处提前结束标签 ——
 *      那个元素及其后续结构从截图里静默消失。我据此以为「共 N 张实拍」整行没实现。
 *
 *   2) disabled 之类的属性必须透传。不传的话 `[disabled]` 这类属性选择器永远
 *      匹配不到，我据此以为「禁用态样式没生效」，而真机上是生效的。
 *
 *   3) 元素名要映射进 CSS 选择器。`.wd-imgs image { min-height: … }` 这种后代选择器
 *      在渲染成 div 之后匹配不上，图片区高度 0、整段消失 ——
 *      我据此以为「公示详情不显示照片」，而产品早就写了 min-height 与占位底色。
 *      （试过输出 <image> 标签，但 HTML 解析器把它当 <img> 的别名，元素名仍是 img，
 *      所以最终是在 CSS 预处理里把 image/text/view/scroll-view 映射成 img/span/div。）
 *
 *   4) **它不能比真机宽松**。渲染用的是真 JS 求值，而 WXML 的数据绑定不支持
 *      函数调用：`picked.indexOf(id) >= 0` 在预览里算得出 true、勾照常显示，
 *      真机上却求值为空、判断恒假。用户截图里一个勾都没亮，我在渲染图上看到的
 *      却是勾选生效 —— 这是最坏的一类骗法：它让我确信自己修好了。
 *      现已按真机行为返回空并告警；同时 tests/miniprogram-structure.test.js
 *      有一条守卫全量扫 wxml 禁止函数调用（注入验证过）。
 *
 * 还有一类不是工具的问题但同样会误判：**自己造的测试数据不自洽**。
 * 本轮有 4 次我把 fixture 缺字段当成产品缺陷（账单状态徽章、券有效期、
 * 收据抵扣行、访客日期），回源码核对后 3 次证明产品是对的。
 * 所以 fixture 里的枚举文案一律从 utils/labels.js 取，不要手写。
 *
 * 结论：**任何异常先怀疑工具与数据，再怀疑产品**，并且回源码核对过才下结论。
 */
// WXML + WXSS → HTML，用于视觉审查（不是运行时，只求布局/间距/层级保真）
import { readFileSync, writeFileSync } from 'node:fs';

const TAG = { view: 'div', text: 'span', button: 'div', 'scroll-view': 'div', block: 'template-block',
              image: 'img', navigator: 'div', canvas: 'div', form: 'div', input: 'input', textarea: 'textarea',
              picker: 'div', switch: 'div', checkbox: 'div', radio: 'div', label: 'label', 'rich-text': 'div' };

/**
 * {{ expr }} 求值：只支持属性访问、三元、比较、字面量。
 *
 * **必须比真机更严格，不能更宽松**（这是它第 5 次骗我，2026-08-03）：
 * 这里用的是真 JS 求值，于是 `picked.indexOf(id) >= 0` 在预览里照常算出 true、
 * 勾也照常显示；而 **WXML 的数据绑定不支持函数调用**，真机上这段求值为空、
 * 判断恒假 —— 用户截图里一个勾都没亮，我却在渲染图上看到勾选生效。
 * 现在遇到函数调用一律按真机行为返回空，并往 stderr 喊一声。
 */
function evalExpr(src, scope) {
  if (/\.[a-zA-Z_$][\w$]*\s*\(/.test(src)) {
    process.stderr.write(`⚠ WXML 不支持函数调用，真机上这段求值为空：{{${src.trim()}}}\n`);
    return '';
  }
  const code = `with(__s){ return (${src}); }`;
  try { return new Function('__s', code)(scope); } catch { return ''; }
}
function interpolate(s, scope) {
  return s.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const v = evalExpr(e, scope);
    return v === undefined || v === null || v === false ? '' : String(v);
  });
}

/**
 * WXML 解析：手写扫描，不用正则匹配整个标签。
 *
 * 必须引号感知：属性值里有 `>` 是常见的（wx:if="{{item.count > 1}}"），
 * 用 `[^>]*?` 会在表达式里的 `>` 处提前结束标签 ——
 * 那个元素及其后续结构会被静默丢掉，截图里看不出来，我就会据此得出错误的界面结论。
 * 第一版就是这么把「共 N 张实拍」整行弄丢的。
 */
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); i = e < 0 ? src.length : e + 3; continue; }
    if (src[i] === '<') {
      // 扫到未被引号包裹的 '>'
      let j = i + 1, q = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (q) { if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '>') break;
      }
      toks.push({ type: 'tag', raw: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const nxt = src.indexOf('<', i);
    const text = src.slice(i, nxt < 0 ? src.length : nxt);
    if (text.trim()) toks.push({ type: 'text', raw: text });
    i = nxt < 0 ? src.length : nxt;
  }
  return toks;
}

function parse(src) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  for (const t of tokenize(src)) {
    const top = stack[stack.length - 1];
    if (t.type === 'text') { top.children.push({ tag: '#text', value: t.raw }); continue; }
    const inner = t.raw.slice(1, -1);
    if (inner.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
    const selfClose = inner.endsWith('/') ? '/' : '';
    const nameM = /^([a-zA-Z-]+)/.exec(inner);
    if (!nameM) continue;
    const open = nameM[1];
    const attrStr = inner.slice(open.length, inner.length - (selfClose ? 1 : 0));
    {
      const attrs = {};
      const ar = /([a-zA-Z:\-_.]+)\s*=\s*"([^"]*)"|([a-zA-Z:\-_.]+)/g;
      let a;
      while ((a = ar.exec(attrStr || ''))) { if (a[1]) attrs[a[1]] = a[2]; else if (a[3]) attrs[a[3]] = ''; }
      const node = { tag: open, attrs, children: [] };
      top.children.push(node);
      const VOID = new Set(['image', 'input', 'br']);
      if (!selfClose && !VOID.has(open)) stack.push(node);
    }
  }
  return root;
}

function render(node, scope) {
  if (node.tag === '#text') return interpolate(node.value, scope);
  if (node.tag === 'root') return node.children.map((c) => render(c, scope)).join('');

  const a = node.attrs;
  // wx:for
  if (a['wx:for'] !== undefined) {
    const listExpr = a['wx:for'].replace(/^\{\{|\}\}$/g, '');
    const list = evalExpr(listExpr, scope) || [];
    const itemName = a['wx:for-item'] || 'item';
    const idxName = a['wx:for-index'] || 'index';
    const clone = { ...node, attrs: { ...a } };
    delete clone.attrs['wx:for']; delete clone.attrs['wx:for-item']; delete clone.attrs['wx:for-index'];
    return (Array.isArray(list) ? list : []).map((it, i) =>
      render(clone, { ...scope, [itemName]: it, [idxName]: i })).join('');
  }
  // wx:if / elif / else —— 由父层顺序处理，这里只判自身
  if (a['wx:if'] !== undefined) {
    const v = evalExpr(a['wx:if'].replace(/^\{\{|\}\}$/g, ''), scope);
    if (!v) { node.__falsy = true; return ''; }
  }
  if (a['wx:elif'] !== undefined || a['wx:else'] !== undefined) {
    // 简化：elif/else 仅在前一个兄弟为假时渲染，交由 renderChildren 处理
  }

  const tag = TAG[node.tag] || 'div';
  const cls = a.class ? interpolate(a.class, scope) : '';
  const style = a.style ? interpolate(a.style, scope) : '';
  const inner = renderChildren(node, scope);
  if (tag === 'template-block') return inner;
  /*
   * disabled 必须透传。
   * 不传的话 [disabled] 这类属性选择器在渲染里永远匹配不到 ——
   * 我据此会以为「禁用态没生效」，而真机上是生效的（第一版就这么误判过一次）。
   */
  /*
   * 带上原始的 WXML 元素名。
   *
   * 元素选择器（`picker { flex: 1 }`）此前是靠把选择器里的元素名改写成 HTML 标签
   * 来支持的，而 view / picker / button / scroll-view 全都映射成 div ——
   * 于是 `picker {}` 被改写成 `div {}`，命中页面上**每一个 div**。
   * 2026-08-02 实测：给 picker 加 flex:1，整页布局塌了，而我一度以为是自己 CSS 写错。
   *
   * 改成用 data-wx 标记原始元素名，选择器改写成属性选择器，各元素就互不干扰了。
   * 这是这类问题的第 4 次（前三次记在文件头），这次从根上解决。
   */
  let extraAttr = ` data-wx="${node.tag}"`;
  if (a.disabled !== undefined) {
    const raw = a.disabled;
    const val = /^\{\{[\s\S]*\}\}$/.test(raw) ? evalExpr(raw.replace(/^\{\{|\}\}$/g, ''), scope) : raw !== 'false';
    if (val) extraAttr += ' disabled';
  }
  if (node.tag === 'image') {
    /*
     * 必须保留 image 这个标签名。
     * 渲染成 div 的话，`.wd-imgs image { min-height: ... }` 这类**后代选择器**匹配不上 ——
     * 图片区在截图里高度为 0、整段消失，我会误判成「公示详情不显示照片」。
     * 实际产品早就给了 min-height 与占位底色（注释里写着「避免照片消失」）。
     * 这是工具第 3 次骗我，改成自定义元素后选择器照常生效。
     */
    /*
     * src 是 data:/http 时真的画出来(手册里的二维码不能是一块空色块);
     * cloud:// 这类小程序专属协议画不了,保持占位底色。
     */
    const src = a.src ? interpolate(a.src, scope) : '';
    const drawable = /^(data:|https?:)/.test(src);
    // style 属性外层是双引号,url 里必须用单引号 —— 用双引号属性在第一个内引号处就断了
    const bg = drawable
      ? `background:#fff url('${src.replace(/["']/g, (m) => encodeURIComponent(m))}') center/contain no-repeat`
      : 'background:#e6ded2';
    const st = `${style};${bg};display:block`;
    return `<image class="${cls}" style="${st}" data-wx="image"></image>`;
  }
  if (node.tag === 'input' || node.tag === 'textarea') {
    /*
     * 有 value 就画 value（用正文色），没有才画 placeholder（用灰色）。
     *
     * 原来一律只画 placeholder：于是「已经填好的表单」在图里永远是空的 ——
     * 用它做使用手册，一眼就看出不是真机。而 value 本来就在数据里，
     * 不画它是白丢信息。
     */
    const val = a.value ? interpolate(a.value, scope) : '';
    const ph = a.placeholder ? interpolate(a.placeholder, scope) : '';
    const text = val || ph;
    const color = val ? 'inherit' : '#b9b2c4';
    /*
     * 必须自己做垂直居中:真 <input> 的文字天生在框内居中,
     * 而 div 里的文字贴顶 —— 渲染出来就是「字浮在输入框上方」。
     */
    const box = node.tag === 'textarea' ? 'align-items:flex-start;padding-top:8px' : 'align-items:center';
    return `<div class="${cls}" style="${style};color:${color};display:flex;${box}">${text}</div>`;
  }
  return `<${tag} class="${cls}" style="${style}"${extraAttr}>${inner}</${tag}>`;
}

function renderChildren(node, scope) {
  let out = '';
  let lastCond = null;
  for (const c of node.children) {
    if (c.tag === '#text') { out += interpolate(c.value, scope); continue; }
    const a = c.attrs || {};
    if (a['wx:if'] !== undefined) {
      lastCond = !!evalExpr(a['wx:if'].replace(/^\{\{|\}\}$/g, ''), scope);
      if (lastCond) out += renderNodeNoCond(c, scope);
      continue;
    }
    if (a['wx:elif'] !== undefined) {
      if (lastCond) continue;
      lastCond = !!evalExpr(a['wx:elif'].replace(/^\{\{|\}\}$/g, ''), scope);
      if (lastCond) out += renderNodeNoCond(c, scope);
      continue;
    }
    if (a['wx:else'] !== undefined) {
      if (!lastCond) out += renderNodeNoCond(c, scope);
      lastCond = null;
      continue;
    }
    lastCond = null;
    out += render(c, scope);
  }
  return out;
}
function renderNodeNoCond(node, scope) {
  const clone = { ...node, attrs: { ...node.attrs } };
  delete clone.attrs['wx:if']; delete clone.attrs['wx:elif']; delete clone.attrs['wx:else'];
  return render(clone, scope);
}

/** rpx → px（375pt 宽：1rpx = 0.5px） */
function rpx(css) { return css.replace(/([\d.]+)rpx/g, (_, n) => `${(parseFloat(n) * 0.5).toFixed(3)}px`); }

/**
 * 选择器里的小程序元素名换成对应的 HTML 标签。
 *
 * 不做这一步，`.wd-imgs image { min-height: ... }` 永远匹配不上 ——
 * 图片区高度 0、整段从截图里消失，我就会误判成「公示详情不显示照片」。
 * （试过把标签渲染成 <image>，但 HTML 解析器会把它当成 <img> 的别名，
 * DOM 里的元素名仍是 img，选择器照样不匹配。）
 *
 * 只在「{ 之前的选择器部分」替换，避免动到 text-align 这类属性名。
 */
/*
 * 必须覆盖 TAG 里**所有**会被改名的元素，否则 `picker { flex: 1 }` 这类
 * 元素选择器在预览里静默失配 —— 规则明明写了、渲染上看不出任何变化，
 * 于是人会以为是自己的 CSS 没写对（2026-08-02 实测：为此改了三遍 picker 的样式）。
 *
 * 这是本工具第 4 次栽在「元素名没映射进 CSS 选择器」上，前三次记在文件头。
 * 所以这里不再逐个手写，直接从 TAG 派生 —— 以后 TAG 加了新元素，这里自动跟上。
 * 只排除 block（它渲染成 template-block，本来就不该被 CSS 选中）。
 */
const WX_ELEMENTS = Object.keys(TAG).filter((t) => t !== 'block');
function mapSelectors(css) {
  return css.replace(/([^{}]+)(\{)/g, (all, sel, brace) => {
    // @media 等 at-rule 的前导部分不动
    if (/@\w/.test(sel)) return all;
    let out = sel;
    /*
     * 改写成属性选择器而不是 HTML 标签名。
     * 换成标签名会让 view / picker / button / scroll-view 全都变成 div，
     * 于是 `picker {}` 命中每一个 div —— 见 render() 里 data-wx 那段注释。
     */
    for (const wx of WX_ELEMENTS) {
      out = out.replace(
        new RegExp(`(^|[\\s,>+~(])${wx}(?=$|[\\s,>+~:.\\[)])`, 'g'),
        `$1[data-wx="${wx}"]`,
      );
    }
    return out + brace;
  });
}

const [, , wxmlPath, wxssPath, appWxssPath, dataPath, outPath, title, chromeTitle] = process.argv;

/*
 * 微信外壳：状态栏 + 右上胶囊 + 原生导航栏。
 *
 * 第 8 个参数给了就画（值就是导航栏标题；给 '-' 表示自定义导航的页面，只画状态栏）。
 * 为什么要画：真机上这三样永远在，不画的图一眼就能看出不是手机截的 ——
 * 而手册的用途正是「让人对着图找按钮」。这是补齐真实,不是伪装。
 */
function wxChrome(t) {
  if (!t) return '';
  const bar = t === '-' ? '' : `
  <div class="__nav">
    <span class="__back">‹</span>
    <span class="__title">${t}</span>
  </div>`;
  return `
<div class="__status">
  <span class="__time">9:41</span>
  <span class="__icons">
    <svg width="17" height="11" viewBox="0 0 17 11"><g fill="#251c38">
      <rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="5" width="3" height="6" rx="1"/>
      <rect x="9" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1"/></g></svg>
    <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 10.5 1 4.2A9.6 9.6 0 0 1 15 4.2Z" fill="none" stroke="#251c38" stroke-width="1.4"/></svg>
    <svg width="26" height="12" viewBox="0 0 26 12"><rect x="0.6" y="0.6" width="21" height="10.8" rx="2.6" fill="none" stroke="#251c38" stroke-opacity=".5"/><rect x="2.2" y="2.2" width="17.8" height="7.6" rx="1.4" fill="#251c38"/><rect x="23" y="4" width="2" height="4" rx="1" fill="#251c38" fill-opacity=".5"/></svg>
    <span class="__capsule"><b>•••</b><i></i><b>◎</b></span>
  </span>
</div>${bar}`;
}
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const tree = parse(readFileSync(wxmlPath, 'utf8'));
const body = renderChildren(tree, data);
const css = mapSelectors(rpx(readFileSync(appWxssPath, 'utf8')) + '\n' + rpx(readFileSync(wxssPath, 'utf8')));
writeFileSync(outPath, `<!doctype html><html><head><meta charset="utf-8">
<style>
html,body{margin:0;padding:0;width:375px;font-size:16px}
/* 微信外壳（见 wxChrome） */
.__status{height:44px;display:flex;align-items:center;justify-content:space-between;
  padding:0 14px 0 18px;background:#f6f0e7;font:600 15px -apple-system,"PingFang SC",sans-serif;color:#251c38}
.__status .__icons{display:flex;align-items:center;gap:5px}
.__capsule{display:inline-flex;align-items:center;gap:7px;margin-left:6px;height:32px;padding:0 11px;
  border-radius:999px;background:rgba(255,255,255,.92);border:.5px solid rgba(0,0,0,.07);
  box-shadow:0 1px 3px rgba(0,0,0,.06);font-size:12px;color:#251c38}
.__capsule i{width:.5px;height:15px;background:rgba(0,0,0,.12)}
.__nav{height:44px;display:flex;align-items:center;justify-content:center;position:relative;
  background:#f6f0e7;border-bottom:.5px solid rgba(37,28,56,.06)}
.__nav .__back{position:absolute;left:14px;font-size:24px;line-height:1;color:#251c38}
.__nav .__title{font:600 17px -apple-system,"PingFang SC",sans-serif;color:#251c38}
image{display:block;background:#e6ded2}
*{box-sizing:border-box}
${css}
.__label{position:fixed;top:0;left:0;background:#000;color:#fff;font:11px monospace;padding:2px 6px;z-index:99}
</style></head><body>
<!-- 视口牢笼:无头 Chrome 的最小布局视口是 500px,--window-size=375 只裁截图不改排版,
     position:fixed 的元素会锚到 500 宽的真视口、落进被裁掉的 125px 里(2026-08-15 用浮动
     催缴条实测)。给 body 一个 transform,让 fixed 后代改锚到这个 375px 的容器上。 -->
<div style="position:relative;width:375px;min-height:100vh;transform:translate(0,0)">
${wxChrome(chromeTitle)}${body}
</div></body></html>`);
console.log('written', outPath);
