const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MP = path.join(__dirname, '..', 'apps', 'miniprogram');

/**
 * 加载失败不得伪装成「没有数据」。
 *
 * 这是业主端最危险的一类缺陷，因为它**看起来完全正常**：
 *   · 首页 onShow 的 catch 只 console.error，然后 finally 把 ready 置 true，
 *     界面按 data 初值渲染「待缴合计（0 笔）/ ¥ 0.00 / 立即缴纳」。业主据此认为
 *     自己没有欠费，逾期了都不知道。切换房屋时更确定，因为 houseChanged 分支会先
 *     把金额清成 '0.00' 再去请求。
 *   · 账单页 fetchPage 抛出的异常一路冒到 onShow 之外无人处理，bills 保持空数组，
 *     界面显示「暂无账单 / 当前分类下没有账单」。
 *   · 「我的」页失败时 currentHouse 保持 null，显示「尚未绑定房屋 / 点击绑定您的
 *     房屋」——业主明明绑好了，看到这句会以为绑定掉了，再去提交一次实名申请。
 *
 * 三处的共同点是：失败路径与「空数据」路径落在同一个渲染分支上。所以守卫要查的是
 * 「这两条路径是否可区分」，而不是「有没有 try/catch」。
 */

function read(rel) {
  return fs.readFileSync(path.join(MP, rel), 'utf8');
}

function code(rel) {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** 页面 → [错误状态字段, wxml 里必须出现的重试绑定] */
const PAGES = [
  { name: '首页', js: 'pages/index/index.js', wxml: 'pages/index/index.wxml', flag: 'error', retry: 'retry' },
  { name: '账单页', js: 'pages/bill/bill.js', wxml: 'pages/bill/bill.wxml', flag: 'error', retry: 'retry' },
  { name: '我的', js: 'pages/mine/mine.js', wxml: 'pages/mine/mine.wxml', flag: 'loadError', retry: 'retryProfile' },
];

test('金额/账单/绑定三个页面都有独立的加载失败状态', () => {
  const bad = [];
  for (const p of PAGES) {
    const js = code(p.js);
    // data 初值里要声明，否则首帧 wx:if 读到 undefined
    if (!new RegExp(`\\b${p.flag}\\s*:\\s*false`).test(js)) {
      bad.push(`${p.name}：data 里没有 ${p.flag}: false`);
    }
    // catch 分支里要置位，光声明不置位等于没有
    if (!new RegExp(`${p.flag}\\s*:\\s*true`).test(js)) {
      bad.push(`${p.name}：没有任何地方把 ${p.flag} 置为 true`);
    }
    if (!new RegExp(`\\b${p.retry}\\s*\\(`).test(js)) {
      bad.push(`${p.name}：缺少 ${p.retry}() 方法`);
    }
  }
  assert.deepStrictEqual(bad, [], '\n  ' + bad.join('\n  '));
});

test('错误状态必须真的参与渲染，且带重试入口', () => {
  const bad = [];
  for (const p of PAGES) {
    const wxml = read(p.wxml);
    if (!wxml.includes(p.flag)) {
      // 这正是 pay-confirm 的 loaded 犯过的错：声明了、置位了，模板里从不使用
      bad.push(`${p.name}：wxml 里从未使用 ${p.flag}，状态置了也没人看`);
    }
    if (!new RegExp(`bindtap="${p.retry}"`).test(wxml)) {
      bad.push(`${p.name}：wxml 里没有绑定 ${p.retry} 的重试按钮`);
    }
  }
  assert.deepStrictEqual(bad, [], '\n  ' + bad.join('\n  '));
});

test('失败时不显示金额（宁可无，不可为 0）', () => {
  /*
   * 「¥ 0.00」比「加载失败」危险得多：后者业主会重试，前者他直接走了。
   * 首页的金额区必须被 !error 门控，且 catch 里要把金额清成空串而不是 '0.00'。
   */
  const wxml = read('pages/index/index.wxml');
  assert.match(
    wxml,
    /wx:if="\{\{ready && !noHouse && !error\}\}"/,
    '首页主内容区没有被 !error 门控，失败时会渲染出 ¥ 0.00',
  );
  const js = code('pages/index/index.js');
  assert.match(
    js,
    /error:\s*true[^}]*unpaidTotal:\s*''/,
    '首页 catch 里没有把 unpaidTotal 清空——留着 0.00 会被当成「没有欠费」',
  );
});

test('账单页：错误态优先于「暂无账单」', () => {
  const wxml = read('pages/bill/bill.wxml');
  const errAt = wxml.search(/wx:if="\{\{error/);
  const emptyAt = wxml.indexOf('暂无账单');
  assert.ok(errAt > -1, '账单页没有错误态分支');
  assert.ok(emptyAt > -1, '账单页没有空状态（不该被删掉）');
  assert.ok(errAt < emptyAt, '错误态必须排在「暂无账单」之前，否则永远走不到');
  // 必须是 elif，否则两块会同时渲染
  assert.match(wxml, /wx:elif="\{\{bills\.length === 0\}\}"/, '空状态应为 wx:elif，避免与错误态同时出现');
});

test('我的：失败态不得把业主引向重复绑定', () => {
  const wxml = read('pages/mine/mine.wxml');
  // 失败卡片的点击目标必须是重试，不能是 goBind
  const m = wxml.match(/<view class="current-house card" bindtap="(\w+)" wx:if="\{\{!currentHouse && loadError\}\}"/);
  assert.ok(m, '我的页没有独立的「加载失败」房屋卡片');
  assert.strictEqual(m[1], 'retryProfile', '失败卡片点击后应重试，而不是跳绑定流程');
});

test('pay-confirm：报价未回来时不显示金额', () => {
  /*
   * loaded 早就声明并置位了，但模板里从不使用，于是进入本页的第一帧是
   * 「应付金额 ¥ 0.00」，报价回来后才跳成真实金额。在一个要按这个数字扣钱的页面
   * 上闪一个 0，业主会怀疑金额到底是多少。
   */
  const wxml = read('pages/pay-confirm/pay-confirm.wxml');
  assert.match(wxml, /wx:if="\{\{loaded\}\}"[\s\S]{0,120}totalAmount/, 'pay-confirm 的金额没有被 loaded 门控');
  const js = code('pages/pay-confirm/pay-confirm.js');
  assert.match(js, /loaded:\s*false/, 'loaded 的初值必须是 false');
  assert.match(js, /loaded:\s*true/, 'loaded 必须在报价到位后置 true');
});

test('声明了却从不在模板里使用的状态字段（置了位也没人看）', () => {
  /*
   * pay-confirm 的 loaded 就是这么被漏掉的：js 里声明 + 置位都齐了，模板里零引用。
   * 这里对全部页面做一次形状检查：data 里以 loading/error/loaded/empty 收尾或开头的
   * 布尔状态字段，必须在同名 wxml 里出现。
   */
  const offenders = [];
  const pagesDir = path.join(MP, 'pages');
  for (const dir of fs.readdirSync(pagesDir)) {
    const jsPath = path.join(pagesDir, dir, `${dir}.js`);
    const wxmlPath = path.join(pagesDir, dir, `${dir}.wxml`);
    if (!fs.existsSync(jsPath) || !fs.existsSync(wxmlPath)) continue;
    const js = fs.readFileSync(jsPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const dataAt = js.indexOf('data: {');
    if (dataAt === -1) continue;
    const block = js.slice(dataAt, js.indexOf('\n  },', dataAt));
    const wxml = fs.readFileSync(wxmlPath, 'utf8');
    for (const m of block.matchAll(/(\w*(?:[Ll]oading|[Ee]rror|[Ll]oaded|[Ee]mpty)\w*)\s*:\s*(?:true|false)\b/g)) {
      const field = m[1];
      if (!new RegExp(`\\b${field}\\b`).test(wxml)) {
        offenders.push(`${dir}: data.${field} 在 ${dir}.wxml 里零引用`);
      }
    }
  }
  if (offenders.length) {
    throw new Error(
      '以下状态字段声明并置位了，但模板从不使用——用户看不到任何区别：\n  ' +
        offenders.join('\n  ') +
        '\n要么在 wxml 里用上，要么从 data 里删掉。',
    );
  }
});
