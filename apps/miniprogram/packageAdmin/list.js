const { adminRequest } = require('../utils/admin');
async function fetchAll(path) {
  const rows = [], seen = new Set();
  let total = null;
  for (let page = 1; page <= 200; page++) {
    const d = await adminRequest(path + (path.includes('?') ? '&' : '?') + 'page=' + page + '&pageSize=200', { silent: true });
    if (!d || !Array.isArray(d.list) || !Number.isInteger(d.total) || d.total < 0) throw new Error('数据加载失败，请重试');
    if (total !== null && total !== d.total) throw new Error('数据已更新，请刷新');
    total = d.total;
    for (const row of d.list) {
      const key = row.id || row.orderNo;
      if (!key || seen.has(key)) throw new Error('数据已更新，请刷新');
      seen.add(key);rows.push(row);
    }
    if (rows.length === total) return rows;
    if (!d.list.length || rows.length > total) throw new Error('数据加载不完整，请重试');
  }
  throw new Error('数据量较大，请缩小查询范围');
}
function cents(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw new Error('金额数据异常');
  const parts = String(value).split('.');
  const n = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw new Error('金额数据异常');
  return n;
}
function pageSlice(rows, page) { return rows.slice((page - 1) * 20, page * 20); }
module.exports = { fetchAll, cents, pageSlice };
