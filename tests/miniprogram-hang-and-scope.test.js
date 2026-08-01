const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * 2026-08-01 小程序全量排查的产物。
 *
 * 排查的出发点是当天两次事故的共性：**出了问题但界面上看不出来**，
 * 以及**没有超时的等待**。按这两条把小程序过了一遍，真问题三个：
 *
 *   ① 图片上传没有超时。而报修提交时外面套着 wx.showLoading({ mask: true }) ——
 *      mask 会锁死整个界面，上传挂住就等于业主完全没有出路。
 *      这和支付那次「一直转圈」是同一个缺陷，只是换了个文件。
 *   ② wx.login 没有超时。它在启动路径上，卡住时小程序停在首屏，
 *      没有提示也没有重试入口，业主只会以为「这个小程序打不开」。
 *   ③ 注销时的欠费警告只查「当前选中的那一户」。绑了两户的业主若欠费在另一户，
 *      注销时完全看不到警告 —— 而这个警告存在的全部意义就是防这件事。
 *
 * 其余维度扫下来是干净的（11 个写入口全有防重复点击、成功提示都在拿到服务端
 * 结果之后、金额显示都有兜底、生命周期钩子齐全）。
 * 过程中我的扫描器误报了 11 次（漏了解构写法、标志名清单不全），
 * 所以下面每一条都是回源码核对过的。
 */

const MP = path.join(__dirname, '..', 'apps/miniprogram');
const read = (p) => fs.readFileSync(path.join(MP, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 取方法体。必须锚定**方法定义**（`async name(`），不能用裸名字 indexOf ——
 * 文件里往往先出现调用处（如 `this.confirmDeleteAccount()`），
 * 从那里切片会切到另一个方法，于是断言检查的是完全不相干的代码。
 * 我写这个文件时就被它骗了一次：报「仍依赖当前选中的房屋」，而实际代码早改好了。
 */
function methodBody(src, name) {
  const m = new RegExp(`\\n  (?:async )?${name}\\s*\\(`).exec(src);
  assert.ok(m, `找不到方法定义 ${name}`);
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') {
      d--;
      if (d === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`${name} 括号不配对`);
}


// ───────────────────── ① 图片上传必须有超时 ─────────────────────

test('① 上传超时不能只靠参数——wx.cloud.uploadFile 没有这个参数', () => {
  /*
   * 这是本条的关键。wx.uploadFile 支持 timeout 参数，而
   * **wx.cloud.uploadFile 的文档里没有** —— 而真机跑的恰恰是云存储那条
   * （config.useCloud）。只加参数等于只修了回滚路径，主路径照旧会挂。
   * 所以必须有一个不依赖参数的机制：计时器 + task.abort()。
   */
  const src = strip(read('utils/upload.js'));
  assert.match(src, /UPLOAD_TIMEOUT_MS/, '超时值应提为具名常量');
  assert.match(src, /setTimeout\(/, '没有自己的计时器，云上传路径不受保护');
  assert.match(src, /\.abort\(\)/, '超时后没有中止上传任务');

  // 两条路径都要走同一个包装
  const cloudIdx = src.indexOf('wx.cloud.uploadFile');
  const plainIdx = src.lastIndexOf('wx.uploadFile(');
  assert.ok(cloudIdx > 0 && plainIdx > 0, '两条上传路径都应存在');
  for (const [name, idx] of [['cloud', cloudIdx], ['wx.uploadFile', plainIdx]]) {
    const before = src.slice(Math.max(0, idx - 200), idx);
    assert.match(before, /withTimeout\(/, `${name} 路径没有套超时包装`);
  }
});

test('① 超时值落在合理区间——照片比接口请求大得多，但必须有上限', () => {
  const ms = Number(/UPLOAD_TIMEOUT_MS\s*=\s*(\d+)/.exec(read('utils/upload.js'))[1]);
  assert.ok(ms >= 15000, `${ms}ms 太短，弱网下会误杀正常上传`);
  assert.ok(ms <= 60000, `${ms}ms 太长，界面被 mask 锁死这么久等于没设`);
});

test('① 超时逻辑真的会超时并中止（跑起来验，不只读代码）', async () => {
  /*
   * 只断言「源码里有 setTimeout」是不够的 —— 计时器可能没接上、
   * abort 可能没调、也可能重复 reject。这里用假的 wx 真跑一遍。
   */
  const timers = [];
  let aborted = false;
  global.wx = {
    cloud: {
      uploadFile() {
        // 永不回调，模拟挂住
        return { abort: () => { aborted = true; } };
      },
    },
    getStorageSync: () => '',
  };
  // 用一个极短的超时跑，避免测试真等 30 秒
  const srcPath = path.join(MP, 'utils/upload.js');
  const original = fs.readFileSync(srcPath, 'utf8');
  const patched = original.replace(/UPLOAD_TIMEOUT_MS = \d+/, 'UPLOAD_TIMEOUT_MS = 40');
  const tmp = path.join(MP, 'utils/.upload-timeout-probe.js');
  fs.writeFileSync(tmp, patched);
  try {
    delete require.cache[require.resolve(tmp)];
    const { uploadImage } = require(tmp);
    await assert.rejects(uploadImage('/tmp/a.jpg'), /超时/);
    assert.ok(aborted, '超时后没有调用 task.abort()，上传会继续占用网络');
  } finally {
    fs.unlinkSync(tmp);
    delete global.wx;
  }
  void timers;
});

test('① 上传成功时不受超时影响，且不会重复结算', async () => {
  let resolves = 0;
  global.wx = {
    cloud: {
      uploadFile(opts) {
        setTimeout(() => {
          opts.success({ fileID: 'cloud://x/y.png' });
          // 再调一次，模拟异常 SDK 行为：不能因此重复 resolve
          opts.success({ fileID: 'cloud://x/dup.png' });
        }, 5);
        return { abort: () => {} };
      },
    },
    getStorageSync: () => '',
  };
  try {
    delete require.cache[require.resolve(path.join(MP, 'utils/upload.js'))];
    const { uploadImage } = require(path.join(MP, 'utils/upload.js'));
    const r = await uploadImage('/tmp/a.jpg');
    resolves += 1;
    assert.equal(r, 'cloud://x/y.png');
    assert.equal(resolves, 1);
  } finally {
    delete global.wx;
  }
});

// ───────────────────── ② wx.login 必须有超时 ─────────────────────

test('② wx.login 有超时，且失败原因带得出来', () => {
  /*
   * 它在启动路径上（ensureLogin）。卡住时小程序停在首屏，
   * 没有提示也没有重试入口 —— 业主只会以为「这个小程序打不开」。
   * 另外原来的 fail 回调丢掉了 errMsg，「用户拒绝 / 网络不通 / 超时」
   * 三种情况在日志里长得一模一样。
   */
  const src = strip(read('utils/auth.js'));
  const i = src.indexOf('wx.login({');
  assert.ok(i > 0, '找不到 wx.login');
  const call = src.slice(i, src.indexOf('});', i));
  assert.match(call, /timeout:/, 'wx.login 没有 timeout');
  assert.match(call, /errMsg/, 'fail 回调丢掉了原始原因');

  const ms = Number(/LOGIN_TIMEOUT_MS\s*=\s*(\d+)/.exec(src)[1]);
  assert.ok(ms >= 5000 && ms <= 20000, `登录超时 ${ms}ms 不合理`);
});

// ─────────────── ③ 注销的欠费警告必须覆盖全部房屋 ───────────────

test('③ 注销时查全部房屋的欠费，不是只查当前选中那一户', () => {
  /*
   * /owner/bills/summary 不传 houseId 时汇总名下全部绑定房屋
   * （owner-bills.controller 的 summary：无 houseId 就按 ACTIVE 绑定取全部）。
   * 原来传了 houseId=currentHouse，于是绑两户、欠费在另一户的业主
   * 注销时完全看不到警告。
   */
  const body = methodBody(strip(read('pages/mine/mine.js')), 'confirmDeleteAccount');
  /*
   * 断言范围只取「拼欠费提示」那一段，不是整个方法体。
   *
   * 我第一版写的是「整个方法体里不许出现 currentHouse」—— 结果命中了
   * 注销成功后的清理语句 `app.globalData.currentHouse = null`，那是完全正确的代码。
   * 「整块里不许出现 X」这种断言太脆：它会把不相干的正确代码判成缺陷，
   * 而人会先去怀疑产品。范围必须收到真正相关的那几行。
   */
  const hint = body.slice(0, body.indexOf('const first'));
  assert.match(hint, /request\('\/owner\/bills\/summary'/, '没有查全量欠费');
  assert.ok(
    !/summary\?houseId=/.test(hint),
    '仍按 houseId 查单户——绑多户时欠费在别户就不会提示',
  );
  assert.ok(!/currentHouse/.test(hint), '欠费提示仍依赖当前选中的房屋');
});

test('③ 查不到欠费时如实说，不能静默略过', () => {
  /*
   * 「没有警告」在业主眼里等于「我不欠钱」。查询失败时静默略过
   * 就是一次静默的误导 —— 而这是不可撤销的操作。
   */
  const body = methodBody(strip(read('pages/mine/mine.js')), 'confirmDeleteAccount');
  const catchIdx = body.indexOf('catch');
  assert.ok(catchIdx > 0, '找不到 catch');
  const handler = body.slice(catchIdx, catchIdx + 300);
  assert.match(handler, /unpaidHint\s*=/, 'catch 里没有给出任何提示');
  assert.match(handler, /未能确认/, '没有如实告知「没能确认」');
});

test('③ 两道确认与脱敏文案没被破坏（不可撤销的操作）', () => {
  const src = read('pages/mine/mine.js');
  assert.equal((src.match(/showModal\(/g) || []).length >= 2, true, '少于两道确认');
  assert.match(src, /无法撤销|无法恢复/, '没有说清不可恢复');
  assert.match(src, /张\*/, '脱敏示例文案丢了——文案必须与后端实际行为一致');
});
