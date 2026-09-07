const { ensureAdmin } = require('../../../utils/admin');
const { fmtDateTimeSec, fmtDate } = require('../../../utils/datetime');
const { fetchAll, cents, pageSlice } = require('../../list');
Page({
  data: { loading: true, error: '', rows: [], keyword: '', channels: ['全部渠道', '微信支付', '线下登记'], channelIndex: 0,
    states: ['有效收据', '已作废', '全部状态'], stateIndex: 0, date: '', page: 1, pages: 1, total: 0, amount: '0.00' },
  onLoad(options) { this.houseId = options.houseId || ''; },
  onShow() { this.load(); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  async load() {
    const version = this._version = (this._version || 0) + 1;
    this.setData({ loading: !this._rows, error: '' });
    try {
      await ensureAdmin();
      const rows = (await fetchAll('/admin/payments' + (this.houseId ? '?houseId=' + encodeURIComponent(this.houseId) : '')))
        .filter(r => r.status === 'SUCCESS' || r.status === 'REFUNDED')
        .map(r => ({ ...r, cents: cents(r.totalAmount), amount: (cents(r.totalAmount) / 100).toFixed(2),
          name: (r.bill && r.bill.house && (r.bill.house.displayName || r.bill.house.code)) || '',
          title: (r.bill && r.bill.title) || '', code: (r.bill && r.bill.house && r.bill.house.code) || '',
          at: fmtDateTimeSec(r.paidAt), day: fmtDate(r.paidAt), channelText: r.channel === 'WXPAY' ? '微信支付' : '线下登记',
          stateText: r.status === 'REFUNDED' ? '已作废' : '有效' }));
      if (version !== this._version) return;
      this._rows = rows;
      this.apply();
    } catch (e) { if (version === this._version) this.setData({ error: e.message || '加载失败，请重试' }); }
    finally { if (version === this._version) this.setData({ loading: false }); }
  },
  apply() {
    const d = this.data, q = d.keyword.trim().toLowerCase();
    const rows = (this._rows || []).filter(r => (!q || [r.name,r.code,r.orderNo,r.receiptNo].join(' ').toLowerCase().includes(q)) &&
      (d.channelIndex === 0 || r.channel === (d.channelIndex === 1 ? 'WXPAY' : 'OFFLINE')) &&
      (d.stateIndex === 2 || r.status === (d.stateIndex === 0 ? 'SUCCESS' : 'REFUNDED')) && (!d.date || r.day === d.date));
    const pages = Math.max(1, Math.ceil(rows.length / 20)), page = Math.min(d.page, pages);
    this.setData({ rows: pageSlice(rows,page), total: rows.length, pages, page,
      amount: (rows.filter(r=>r.status==='SUCCESS').reduce((n,r)=>n+r.cents,0)/100).toFixed(2) });
  },
  search(e) { this.setData({ keyword: e.detail.value, page: 1 });this.apply(); },
  filter(e) { this.setData({ [e.currentTarget.dataset.key]: Number(e.detail.value), page: 1 });this.apply(); },
  date(e) { this.setData({ date: e.detail.value, page: 1 });this.apply(); },
  clearDate() { this.setData({ date: '', page: 1 });this.apply(); },
  turn(e) { const page=this.data.page+Number(e.currentTarget.dataset.delta);if(page<1||page>this.data.pages)return;this.setData({page});this.apply();wx.pageScrollTo({scrollTop:0,duration:0}); },
  open(e) { wx.navigateTo({ url: '/packageAdmin/pages/receipt/receipt?orderNo=' + encodeURIComponent(e.currentTarget.dataset.order) }); },
});
