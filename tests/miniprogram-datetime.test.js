const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MP = path.join(__dirname, '..', 'apps', 'miniprogram');
const { fmtDate, fmtDateTime, fmtDateTimeSec } = require(path.join(MP, 'utils', 'datetime.js'));

/**
 * 全站时间必须是北京时间。
 *
 * 后端返回 UTC ISO 串（`2026-07-27T08:08:08.000Z`），而小程序此前 18 处都在裸切
 * 字符串，于是全站时间**早 8 小时**。生产实测：一笔北京时间 16:08:08 缴的费，
 * 缴费记录与电子收据都显示 08:08:08；收据还会把这个错误时间画进保存到相册的图片，
 * 业主拿它当凭证。
 *
 * 日期字段也中招，但方式与直觉相反。用生产真实值核对过两类：
 *   dueDate   = 2026-08-11T15:59:59Z（后端 setHours(23,59,59)，容器 TZ=Asia/Shanghai）
 *               裸切 → 2026-08-11 ✓ 恰好对
 *   visitDate = 2026-07-25T16:00:00Z（后端 new Date(y,m-1,d) 即上海 00:00）
 *               裸切 → 2026-07-25 ✗ 早一天，业主预约的是 07-26
 * 所以「日期能不能裸切」取决于后端把它落在当天的哪个时刻，各模块并不一致；
 * 统一加 8 小时偏移后两类都对。这也是本模块不提供「不转换」变体的原因——那个变体
 * 只在 dueDate 上恰好成立。
 */

test('时间戳按北京时间格式化，不是 UTC', () => {
  // 北京时间 2026-07-27 16:08:08
  const iso = '2026-07-27T08:08:08.000Z';
  assert.strictEqual(fmtDateTime(iso), '2026-07-27 16:08');
  assert.strictEqual(fmtDateTimeSec(iso), '2026-07-27 16:08:08');
  assert.strictEqual(fmtDate(iso), '2026-07-27');
  // 裸切会得到 08:08 —— 正是修复前全站的表现
  assert.notStrictEqual(fmtDateTime(iso), iso.replace('T', ' ').slice(0, 16));
});

test('跨零点：北京时间次日 00:30 不能显示成前一天', () => {
  // 2026-08-01 00:30 +08 == 2026-07-31T16:30Z
  const iso = '2026-07-31T16:30:00.000Z';
  assert.strictEqual(fmtDate(iso), '2026-08-01');
  assert.strictEqual(fmtDateTime(iso), '2026-08-01 00:30');
  // 裸切会显示「缴于 07-31」
  assert.strictEqual(iso.slice(0, 10), '2026-07-31');
});

test('账单到期日（上海 23:59:59 落库）不因偏移跳到次日', () => {
  // 生产真实值
  assert.strictEqual(fmtDate('2026-08-11T15:59:59.000Z'), '2026-08-11');
});

test('访客到访日（上海 00:00 落库）不再早一天', () => {
  // 生产真实值：业主预约的是 2026-07-26
  assert.strictEqual(fmtDate('2026-07-25T16:00:00.000Z'), '2026-07-26');
});

test('解析失败给兜底，绝不产出 NaN / Invalid Date', () => {
  for (const bad of [null, undefined, '', 'not-a-date', {}]) {
    for (const fn of [fmtDate, fmtDateTime, fmtDateTimeSec]) {
      const out = fn(bad, '—');
      assert.ok(!String(out).includes('NaN'), `${fn.name}(${JSON.stringify(bad)}) 产出了 NaN`);
      assert.ok(!String(out).includes('Invalid'), `${fn.name}(${JSON.stringify(bad)}) 产出了 Invalid Date`);
    }
  }
  assert.strictEqual(fmtDateTime('', '—'), '—');
});

test('不受运行设备时区影响（低端机常年设错时区）', () => {
  const iso = '2026-07-27T08:08:08.000Z';
  const before = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      assert.strictEqual(fmtDateTime(iso), '2026-07-27 16:08', `TZ=${tz} 时结果变了`);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

/**
 * 页面里不得再出现裸切。
 *
 * 这一条必须能真正抓到——本会话已有多条守卫因为只 grep「代码里有没有某段文字」
 * 而完全无效。这里检查的是「不得出现某种写法」，属否定式，grep 恰好适用：
 * 只要有人写回 `.slice(0, 16)`，无论它起不起作用都会被拦下。
 */
test('页面不得再裸切 ISO 字符串', () => {
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
        // 时间串的三种典型切法 + 手工拆 T
        const bad = [
          /\.replace\(\s*['"]T['"]\s*,/,
          /\.slice\(\s*0\s*,\s*(?:10|16|19)\s*\)/,
          /\.split\(\s*['"]T['"]\s*\)/,
        ];
        for (const re of bad) {
          if (re.test(src)) offenders.push(`${path.relative(MP, p)} → ${re.source}`);
        }
      }
    }
  };
  walk(path.join(MP, 'pages'));
  if (offenders.length) {
    throw new Error(
      '以下页面在裸切时间字符串，结果会比北京时间早 8 小时（纯日期字段可能早一天）：\n  ' +
        offenders.join('\n  ') +
        '\n请改用 utils/datetime 的 fmtDate / fmtDateTime / fmtDateTimeSec。',
    );
  }
});

test('用到时间格式化的页面都 require 了 datetime', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        const used = [...src.matchAll(/\b(fmtDate|fmtDateTime|fmtDateTimeSec)\s*\(/g)].map((m) => m[1]);
        if (used.length === 0) continue;
        if (!/require\(['"][./]*utils\/datetime['"]\)/.test(src)) {
          offenders.push(`${path.relative(MP, p)} 用了 ${[...new Set(used)].join('/')} 但没有 require`);
          continue;
        }
        // require 的解构清单要覆盖实际用到的函数，否则运行时 undefined is not a function
        const imported = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"][./]*utils\/datetime['"]\)/);
        const names = imported ? imported[1].split(',').map((x) => x.trim()) : [];
        for (const u of new Set(used)) {
          if (!names.includes(u)) offenders.push(`${path.relative(MP, p)} 用了 ${u} 但 require 清单里没有`);
        }
      }
    }
  };
  walk(path.join(MP, 'pages'));
  assert.deepStrictEqual(offenders, []);
});

/*
 * fmtDateShort：同年只给 MM-DD，跨年才带年份。
 *
 * 由来：账单列表一行里挤着「到期 2026-08-31 · 待缴 · 缴费按钮」，
 * 真机实测日期折成「到期 2026-08-」/「31」两行 ——
 * 断在年月中间的日期比短日期难读得多，而「今年」的年份本来就是噪音。
 */
const { fmtDateShort } = require(path.join(MP, 'utils', 'datetime.js'));

test('fmtDateShort：同年省略年份', () => {
  assert.equal(fmtDateShort('2026-08-31T15:59:59.000Z', '', new Date('2026-08-02T00:00:00Z')), '08-31');
});

test('fmtDateShort：跨年保留年份——12 月出账、次年 1 月到期时年份才有信息量', () => {
  assert.equal(fmtDateShort('2027-01-15T00:00:00.000Z', '', new Date('2026-12-20T00:00:00Z')), '2027-01-15');
});

test('fmtDateShort：同年判断按北京时间，不按 UTC', () => {
  /*
   * 12-31 的北京晚上，UTC 还是当年、北京已经跨年 —— parts() 统一转北京时间，
   * 这里钉住「拿 UTC 年份比对」这种回归（那会让元旦前后短日期抽风）。
   * 2026-12-31T20:00Z = 北京 2027-01-01 04:00 → now 在北京已是 2027 年，
   * 2027-01-05 的账单应视为同年 → 省略年份。
   */
  assert.equal(fmtDateShort('2027-01-05T00:00:00.000Z', '', new Date('2026-12-31T20:00:00Z')), '01-05');
});

test('fmtDateShort：非法输入回退 fallback，不产出「NaN-NaN」', () => {
  assert.equal(fmtDateShort(null, '—'), '—');
  assert.equal(fmtDateShort('not-a-date', ''), '');
});
