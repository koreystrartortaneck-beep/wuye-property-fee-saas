const { ensureAdmin } = require('../../../utils/admin');
const { fmtDateTimeSec, fmtDate } = require('../../../utils/datetime');
const { fetchAll, cents, pageSlice } = require('../../list');
function money(value) { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
Page({
  data: { loading: true, error: '', rows: [], keyword: '', channels: ['全部渠道', '微信支付', '线下登记'], channelIndex: 0,
    states: ['有效收据', '已作废', '全部状态'], stateIndex: 0, date: '', page: 1, pages: 1, total: 0, amount: '0.00', amountDisplay:'0.00',
    filtersOpen:false, draftChannel:0, draftState:0, draftDate:'', filterCount:0, filterLabel:'', navTop:20,navHeight:44,navBottom:64 },
  onLoad(options) {
    this.houseId = options.houseId || '';
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const navTop = info.statusBarHeight || 20;
      const capsule = wx.getMenuButtonBoundingClientRect();
      const navHeight = capsule && capsule.height > 0 && capsule.top >= navTop ? (capsule.top - navTop) * 2 + capsule.height : 44;
      this.setData({navTop,navHeight,navBottom:navTop+navHeight});
    } catch (_) { /* 保留无设备信息时的安全尺寸。 */ }
    wx.hideShareMenu();
  },
  back() { if(getCurrentPages().length > 1)wx.navigateBack();else wx.redirectTo({url:'/packageAdmin/pages/home/home'}); },
  noop() {},
  openFilters() { this.setData({filtersOpen:true,draftChannel:this.data.channelIndex,draftState:this.data.stateIndex,draftDate:this.data.date}); },
  closeFilters() { this.setData({filtersOpen:false}); },
  pickDraft(e) { const key=e.currentTarget.dataset.key;if(key==='draftChannel'||key==='draftState')this.setData({[key]:Number(e.currentTarget.dataset.index)}); },
  pickDate(e) { this.setData({draftDate:e.detail.value}); },
  clearDraftDate() { this.setData({draftDate:''}); },
  resetDraft() { this.setData({draftChannel:0,draftState:0,draftDate:''}); },
  applyFilters() { this.setData({channelIndex:this.data.draftChannel,stateIndex:this.data.draftState,date:this.data.draftDate,page:1,filtersOpen:false});this.apply();wx.pageScrollTo({scrollTop:0,duration:0}); },
  resetFilters() { this.setData({channelIndex:0,stateIndex:0,date:'',page:1});this.apply(); },
  resetSearch() { this.setData({keyword:''});this.resetFilters(); },
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
          at: fmtDateTimeSec(r.paidAt), atShort:fmtDateTimeSec(r.paidAt).slice(0,16), amountDisplay:money((cents(r.totalAmount)/100).toFixed(2)), day: fmtDate(r.paidAt), channelText: r.channel === 'WXPAY' ? '微信支付' : '线下登记',
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
    const filterLabels=[];
    if(d.channelIndex)filterLabels.push(d.channels[d.channelIndex]);
    if(d.stateIndex)filterLabels.push(d.states[d.stateIndex]);
    if(d.date)filterLabels.push(d.date);
    const amount=(rows.filter(r=>r.status==='SUCCESS').reduce((n,r)=>n+r.cents,0)/100).toFixed(2);
    this.setData({ rows: pageSlice(rows,page), total: rows.length, pages, page,
      amount,amountDisplay:money(amount),filterCount:filterLabels.length,filterLabel:filterLabels.join(' · ') });
  },
  search(e) { this.setData({ keyword: e.detail.value, page: 1 });this.apply(); },
  filter(e) { this.setData({ [e.currentTarget.dataset.key]: Number(e.detail.value), page: 1 });this.apply(); },
  date(e) { this.setData({ date: e.detail.value, page: 1 });this.apply(); },
  clearDate() { this.setData({ date: '', page: 1 });this.apply(); },
  turn(e) { const page=this.data.page+Number(e.currentTarget.dataset.delta);if(page<1||page>this.data.pages)return;this.setData({page});this.apply();wx.pageScrollTo({scrollTop:0,duration:0}); },
  open(e) { wx.navigateTo({ url: '/packageAdmin/pages/receipt/receipt?orderNo=' + encodeURIComponent(e.currentTarget.dataset.order) }); },
});
