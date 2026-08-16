/*
 * 欠费与催缴 —— 面板组件。
 *
 * 为什么是组件而不是页面:首页要在一屏之内横向切「楼盘图 / 欠费 / 报修 / 待发布」,
 * 而这几块各有几十行逻辑。做成组件,首页与独立页面共用同一份实现 ——
 * 把它抄一份进首页,就是「改一处漏一处」的开始。
 *
 * active 由外部给:变成 true 时才拉数据(没点开的标签不该占网络);
 * 首页每次 onShow 也会让当前面板重新拉一次(收完款回来,数字要变)。
 */
const { adminRequest } = require('../../../utils/admin');

const FILTERS = [
  { key: 0, label: '全部欠费' },
  { key: 30, label: '逾期 30 天+' },
  { key: 90, label: '逾期 90 天+' },
];

Component({
  properties: {
    /** 外部控制:这一块正在被看着吗 —— 只有被看着才拉数据 */
    active: {
      type: Boolean,
      value: false,
      observer(on) {
        if (on) void this.load();
      },
    },
  },

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
    allPicked: false,
    dunning: false,
  },

  methods: {


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
        rows: rows.map((r) => ({ ...r, checked: false })),
        total: d.totalAmount || '0.00',
        totalHouses: d.totalHouses || rows.length,
        overdueHouses: d.overdueHouses || 0,
        truncated: d.truncated ? d.totalHouses : 0,
        picked: [],
        allPicked: false,
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
    this.applyPicked(
      this.data.picked.includes(id) ? this.data.picked.filter((x) => x !== id) : [...this.data.picked, id],
    );
  },

  clearPicked() {
    this.applyPicked([]);
  },

  toggleAll() {
    const all = this.data.rows.map((r) => r.houseId);
    this.applyPicked(this.data.picked.length === all.length ? [] : all);
  },

  /*
   * 勾选状态必须**在 JS 里算成每行一个布尔值**再交给 WXML。
   *
   * 2026-08-03 实测:原来 WXML 里写的是 `picked.indexOf(item.houseId) >= 0`,
   * 界面上一个勾都不出现,而按钮上的「已选 1 户」是对的 ——
   * WXML 的表达式**不支持函数调用**,indexOf(...) 求值为空,
   * 于是判断永远为假。不报错、不告警,只是勾永远不亮。
   * (预览工具用真 JS 求值,所以它照常显示勾 —— 工具比真机宽松,骗过我一次)
   */
  applyPicked(picked) {
    const set = {};
    for (const id of picked) set[id] = true;
    this.setData({
      picked,
      rows: this.data.rows.map((r) => ({ ...r, checked: !!set[r.houseId] })),
      allPicked: picked.length > 0 && picked.length === this.data.rows.length,
    });
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
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    this.setData({ dunning: true });
    try {
      /*
       * requestId = 日期 + 这批户的哈希。两处都不能省:
       *   · 带日期:催缴是要重复做的事(催了不交,过几天再催)。不带日期的话
       *     同一批户第二次点会被服务端判成重放 —— 界面报成功,实际一条没发。
       *   · 用全量哈希而不是截断拼接:截断会让两批不同的户算出同一个 key,
       *     那时服务端会报「幂等键已用于不同请求」,人完全看不懂。
       * 后端另有 6 次/分钟的频率上限。
       */
      const r = await adminRequest('/admin/arrears/dun', {
        method: 'POST',
        data: { houseIds: ids, requestId: `mp-dun-${todayKey()}-${ids.length}-${hash32(ids.slice().sort().join(','))}` },
      });
      /*
       * 如实报数:queued 数的是**账单条数**(一户欠三期就是三条),
       * skipped 是这类提醒本来就排过的。说成「已通知 N 户」是假话。
       */
      const q2 = r && r.queued != null ? r.queued : 0;
      const h = r && r.houses != null ? r.houses : ids.length;
      const sk = r && r.skipped ? r.skipped : 0;
      /*
       * 一条都没排出去要单独说清:同一张账单的同一类提醒系统只发一次
       * (微信一次性订阅本身也不允许重复推),否则物业会以为「点了就发了」,
       * 而业主那边什么都没响。这时唯一有效的手段是打电话。
       */
      wx.showModal({
        title: q2 > 0 ? '已排提醒' : '这次没有新提醒发出',
        content:
          q2 > 0
            ? `${h} 户 · 新排 ${q2} 条${sk > 0 ? `,另有 ${sk} 条之前已排过` : ''}。提醒由微信订阅消息发出,没授权的业主收不到,那几户还得打电话。`
            : `这 ${h} 户的提醒之前已经发过(每张账单的同一类提醒只发一次,微信一次性订阅也不允许重复推)。要继续催,请打电话。`,
        showCancel: false,
      });
      this.setData({ picked: [] });
    } finally {
      this.setData({ dunning: false });
    }
  },
  },
});

/** 本地日期 YYYYMMDD:催缴的幂等键按天分段,同一批户明天还能再催一次 */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/*
 * 32 位字符串哈希(FNV-1a 变体)。
 * 用它而不是「拼起来截断 40 字符」:截断会让两批不同的户算出同一个幂等键,
 * 服务端会报「幂等键已用于不同请求」,而人完全看不懂那句话在说什么。
 */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}
