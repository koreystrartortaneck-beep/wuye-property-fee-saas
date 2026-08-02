/**
 * 时间格式化 —— 单一真源。
 *
 * 为什么必须有这一层：后端返回的时间是 UTC ISO 串（`2026-07-27T08:08:08.000Z`），
 * 而小程序此前 20 处都在裸切字符串（`.replace('T',' ').slice(0,16)`），
 * 于是**全站时间比北京时间早 8 小时**。
 *
 * 生产实测：一笔北京时间 16:08:08 缴的费，缴费记录与电子收据都显示 08:08:08。
 * 收据那一处最严重——`receipt.js` 会把这个错误时间画进保存到相册的图片里，
 * 业主拿它当凭证。
 *
 * 纯日期字段同样中招，只是方式不同。用生产真实值核对过两类：
 *   · 账单到期日 `dueDate = 2026-08-11T15:59:59Z`
 *     （后端 setHours(23,59,59) 在 TZ=Asia/Shanghai 的容器里落库）
 *     裸切前 10 位 → 2026-08-11 ✓ 恰好对
 *   · 访客到访日 `visitDate = 2026-07-25T16:00:00Z`
 *     （后端 new Date(y, m-1, d) 即上海 00:00，换算成 UTC 是前一天 16:00）
 *     裸切前 10 位 → 2026-07-25 ✗ **早一天**，业主预约的是 07-26
 *
 * 也就是说「日期字段能不能裸切」取决于后端把它落在当天的哪个时刻，而这一点
 * 各模块并不一致。统一加 8 小时偏移后两类都对：15:59:59Z+8h 仍是 08-11 当天，
 * 16:00:00Z+8h 是 07-26 当天。所以本模块不提供「不转换」的变体——那个变体只是
 * 恰好在 dueDate 上成立，用到 visitDate/expectDate 上就是错的。
 *
 * 实现选择：手动加 8 小时偏移，而不用 Intl.DateTimeFormat 的 timeZone。
 * 小程序低端机的 JSCore 对 Intl 时区支持不完整，而本项目只服务国内（固定 +8），
 * 固定偏移既准确又没有兼容风险。
 */

/** 北京时间与 UTC 的固定偏移 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把任意时间输入转成北京时间的各个分量。
 * 解析不出来时返回 null，由调用方决定兜底文案（绝不产出 NaN 或 Invalid Date）。
 */
function parts(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  // 加偏移后用 getUTC* 读，等价于读北京时间，且不受运行设备时区影响
  const d = new Date(ms + CST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return {
    y: d.getUTCFullYear(),
    M: p(d.getUTCMonth() + 1),
    D: p(d.getUTCDate()),
    h: p(d.getUTCHours()),
    m: p(d.getUTCMinutes()),
    s: p(d.getUTCSeconds()),
  };
}

/** 北京时间日期：2026-07-27（到期日、有效期、到访日、预约日都用这个） */
function fmtDate(value, fallback = '') {
  const p = parts(value);
  return p ? `${p.y}-${p.M}-${p.D}` : fallback;
}

/**
 * 紧凑日期：同年只给「MM-DD」，跨年才带年份。
 *
 * 为什么：账单列表一行里挤着「到期 2026-08-31 · 待缴徽章 · 缴费按钮」，
 * 真机实测日期在年份后面被折成两行（「到期 2026-08-」/「31」）——
 * 一个断在年月中间的日期比短日期难读得多。
 * 而对「今年到期」的账单，年份本来就是噪音；跨年（12 月出账、次年 1 月到期）
 * 时年份才有信息量，那时保留。
 *
 * now 可注入，测试用；生产不传。
 */
function fmtDateShort(value, fallback = '', now = new Date()) {
  const p = parts(value);
  if (!p) return fallback;
  /*
   * 注意传 Date 本身：parts() 只接受 Date 或 ISO 字符串，
   * 传 now.getTime()（数字）会被 Date.parse 判成 NaN → 返回 null →
   * 同年判断永远不成立，短日期静默失效。第一版就是这么写错的，测试抓住了。
   */
  const curY = parts(now);
  return curY && curY.y === p.y ? `${p.M}-${p.D}` : `${p.y}-${p.M}-${p.D}`;
}

/** 北京时间到分：2026-07-27 16:08 */
function fmtDateTime(value, fallback = '') {
  const p = parts(value);
  return p ? `${p.y}-${p.M}-${p.D} ${p.h}:${p.m}` : fallback;
}

/** 北京时间到秒：2026-07-27 16:08:08（收据等凭证用，需要精确到秒） */
function fmtDateTimeSec(value, fallback = '') {
  const p = parts(value);
  return p ? `${p.y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s}` : fallback;
}

module.exports = { fmtDate, fmtDateShort, fmtDateTime, fmtDateTimeSec };
