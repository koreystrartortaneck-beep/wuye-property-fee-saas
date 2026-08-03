const { adminRequest } = require('../../../utils/admin');

/*
 * 欠费与催缴。
 *
 * 物业催缴的真实顺序是「先打电话,打不通再发通知」—— 所以每一行第一个
 * 可点的东西是拨号,而不是勾选框。批量催缴是补充手段(发微信订阅通知),
 * 不是主力。
 *
 * 两个必须说实话的地方:
 *   · 逾期天数按北京时间算,到期当天不算逾期(后端口径,这里只显示)
 *   · 批量催缴发的是微信订阅通知,业主没授权就收不到 —— 界面里明说,
 *     否则物业以为「发过了」,而业主那边什么都没响
 */

const FILTERS = [
  { key: 0, label: '全部欠费' },
  { key: 30, label: '逾期 30 天+' },
  { key: 90, label: '逾期 90 天+' },
];

Page({
  data: {
    loading: true,
    loadError: false,
    rows: [],
    total: '0.00',
    totalHouses: 0,
    overdueHouses: 0,
    truncated: 0,
    filters: FILTERS,
    overdueDays: 0,
    sort: 'days',
    picked: [],
    dunning: false,
  },

  onShow() {
    void this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    try {
      const q = [`sort=${this.data.sort}`];
      if (this.data.overdueDays > 0) q.push(`overdueDays=${this.data.overdueDays}`);
      const d = await adminRequest(`/admin/arrears?${q.join('&')}`, { silent: true });
      const rows = (d.list || []).map((r) => ({
        houseId: r.houseId,
        name: r.displayName || r.code,
        code: r.code,
        ownerName: r.ownerName || '',
        phone: r.ownerPhone || '',
        unpaidCount: r.unpaidCount,
        unpaidAmount: r.unpaidAmount,
        overdueDays: r.overdueDays || 0,
      }));
      /*
       * 合计取后端的 totalAmount(全量口径),不拿本页这几行相加 ——
       * 列表是截断过的,自己加出来的数会比真实欠费少,而这个数是要拿去汇报的。
       * 截断也必须说出来。
       */
      this.setData({
        rows,
        total: d.totalAmount || '0.00',
        totalHouses: d.totalHouses || rows.length,
        overdueHouses: d.overdueHouses || 0,
        truncated: d.truncated ? d.totalHouses : 0,
        picked: [],
      });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  pickFilter(e) {
    this.setData({ overdueDays: Number(e.currentTarget.dataset.k) }, () => void this.load());
  },

  toggleSort() {
    this.setData({ sort: this.data.sort === 'days' ? 'amount' : 'days' }, () => void this.load());
  },

  toggleRow(e) {
    const id = e.currentTarget.dataset.id;
    const picked = this.data.picked.includes(id)
      ? this.data.picked.filter((x) => x !== id)
      : [...this.data.picked, id];
    this.setData({ picked });
  },

  toggleAll() {
    const all = this.data.rows.map((r) => r.houseId);
    this.setData({ picked: this.data.picked.length === all.length ? [] : all });
  },

  call(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  goHouse(e) {
    wx.navigateTo({ url: `/packageAdmin/pages/house/house?id=${e.currentTarget.dataset.id}` });
  },

  async dun() {
    const ids = this.data.picked;
    if (ids.length === 0) return wx.showToast({ title: '先勾要催的户', icon: 'none' });
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: `催缴 ${ids.length} 户`,
        content: '给这些户发微信缴费提醒。业主没授权过订阅消息的收不到 —— 那几户还得打电话。',
        confirmText: '发提醒',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;
    this.setData({ dunning: true });
    try {
      /*
       * requestId 带上这批户的指纹:同一批重复点是同一次(服务端幂等),
       * 换了一批才算新的一次。后端另有 6 次/分钟的频率上限。
       */
      const r = await adminRequest('/admin/arrears/dun', {
        method: 'POST',
        data: { houseIds: ids, requestId: `mp-dun-${ids.length}-${ids.slice().sort().join('').slice(0, 40)}` },
      });
      /*
       * 如实报数:queued 数的是**账单条数**(一户欠三期就是三条),
       * skipped 是这类提醒本来就排过的。说成「已通知 N 户」是假话。
       */
      const q2 = r && r.queued != null ? r.queued : 0;
      const h = r && r.houses != null ? r.houses : ids.length;
      const sk = r && r.skipped ? r.skipped : 0;
      wx.showModal({
        title: '已排提醒',
        content: `${h} 户 · 新排 ${q2} 条${sk > 0 ? `,另有 ${sk} 条之前已排过` : ''}。提醒由微信订阅消息发出,没授权的业主收不到,那几户还得打电话。`,
        showCancel: false,
      });
      this.setData({ picked: [] });
    } finally {
      this.setData({ dunning: false });
    }
  },
});
