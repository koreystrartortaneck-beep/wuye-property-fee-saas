const { adminRequest } = require('../../../utils/admin');

/*
 * 发账单(手机端)。
 *
 * 三种范围,一套流程:
 *   全部    —— 这条标准这个月该出的全部房屋(周年方案里就是「放户日在本月的」)
 *   某一群  —— 按楼栋圈选
 *   某一户  —— 单选一户补账单
 *
 * 流程是「先看后发」,一步都不省:
 *   选标准+月份 → 预览逐行金额与依据 → 勾掉不该出的 → 生成草稿(业主看不见)
 *   → 核对合计 → 发布(业主可见 + 推送)
 *
 * 「发布」永远是人点的最后一下 —— 这是钱,自动化只做准备工作。
 */

const SKIP_REASON = {
  HANDOVER_DATE_MISSING: '缺放户日期',
  AREA_MISSING: '房屋没填面积',
  ANNIVERSARY_ALREADY_BILLED: '本年度已出过账单',
  EXCLUDED_BY_ADMIN: '本次已剔除',
  METER_READING_MISSING: '本期没有抄表读数',
};

Page({
  data: {
    communityId: '',
    step: 1, // 1 选范围 → 2 预览 → 3 草稿已生成待发布
    rules: [],
    ruleId: '',
    ruleName: '',
    period: '',
    /** 范围:all / building / house */
    scope: 'all',
    buildings: [],
    pickedBuilding: '',
    /** 单户模式的搜索 */
    keyword: '',
    houses: [],
    pickedHouse: null,
    /** 预览 */
    previewing: false,
    rows: [],
    payable: [],
    skipped: [],
    total: '0.00',
    /** 勾掉的户(houseId 数组) */
    excluded: [],
    /** 草稿 */
    generating: false,
    batch: null,
    publishing: false,
  },

  onLoad(q) {
    const now = new Date();
    const patch = {
      communityId: q.communityId || '',
      period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    };
    // 从房屋详情进来:范围直接预置成这一户,省掉再搜一次
    if (q.houseId) {
      patch.scope = 'house';
      patch.pickedHouse = { id: q.houseId, displayName: decodeURIComponent(q.houseName || '') };
      patch.keyword = decodeURIComponent(q.houseName || '');
    }
    this.setData(patch);
    void this.loadRules();
  },

  async loadRules() {
    const d = await adminRequest(`/admin/fee-rules?communityId=${this.data.communityId}&pageSize=100`, { silent: true });
    // 只列启用中的按户周年标准:legacy 规则按房屋类型自动全选,不走这个页面
    const rules = (d.list || []).filter((r) => r.periodScheme === 'ANNIVERSARY' && r.enabled);
    this.setData({ rules });
    if (rules.length === 1) this.setData({ ruleId: rules[0].id, ruleName: rules[0].name });
    void this.loadBuildings();
  },

  async loadBuildings() {
    const g = await adminRequest(`/admin/houses-grid?communityId=${this.data.communityId}`, { silent: true });
    this._grid = g.buildings || [];
    this.setData({ buildings: this._grid.map((b) => ({ building: b.building, houses: b.houses })) });
  },

  pickRule(e) {
    const r = this.data.rules[e.currentTarget.dataset.i];
    this.setData({ ruleId: r.id, ruleName: r.name, rows: [], batch: null, step: 1 });
  },

  onPeriod(e) {
    this.setData({ period: e.detail.value.slice(0, 7), rows: [], batch: null, step: 1 });
  },

  pickScope(e) {
    this.setData({
      scope: e.currentTarget.dataset.s,
      pickedBuilding: '',
      pickedHouse: null,
      keyword: '',
      houses: [],
      rows: [],
      batch: null,
      step: 1,
    });
  },

  pickBuilding(e) {
    this.setData({ pickedBuilding: e.currentTarget.dataset.b, rows: [], batch: null, step: 1 });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
    clearTimeout(this._t);
    if (!e.detail.value.trim()) return this.setData({ houses: [] });
    this._t = setTimeout(async () => {
      const d = await adminRequest(
        `/admin/houses?communityId=${this.data.communityId}&keyword=${encodeURIComponent(this.data.keyword.trim())}&page=1&pageSize=20`,
        { silent: true },
      );
      this.setData({ houses: d.list || [] });
    }, 300);
  },

  pickHouse(e) {
    const h = this.data.houses[e.currentTarget.dataset.i];
    this.setData({ pickedHouse: h, keyword: h.displayName, houses: [], rows: [], batch: null, step: 1 });
  },

  /** 当前范围对应的房屋 id 列表;全部 = undefined(不定向) */
  scopeHouseIds() {
    if (this.data.scope === 'house') return this.data.pickedHouse ? [this.data.pickedHouse.id] : [];
    if (this.data.scope === 'building') {
      const b = (this._grid || []).find((x) => x.building === this.data.pickedBuilding);
      if (!b) return [];
      return b.units.flatMap((u) => u.floors.flatMap((f) => f.cells.map((c) => c.id)));
    }
    return undefined;
  },

  async preview() {
    if (!this.data.ruleId) return wx.showToast({ title: '请先选收费标准', icon: 'none' });
    const ids = this.scopeHouseIds();
    if (ids && ids.length === 0) {
      return wx.showToast({ title: this.data.scope === 'house' ? '请先选一户' : '请先选楼栋', icon: 'none' });
    }
    this.setData({ previewing: true });
    try {
      const q = [`ruleId=${this.data.ruleId}`, `period=${this.data.period}`];
      if (ids) q.push(`onlyHouseIds=${ids.join(',')}`);
      const r = await adminRequest(`/admin/bill-runs/preview?${q.join('&')}`);
      const rows = (r.rows || []).map((x) => ({
        ...x,
        reasonText: x.skipReason ? SKIP_REASON[x.skipReason] || x.skipReason : '',
        basis: x.snapshot
          ? x.snapshot.months
            ? `${x.snapshot.area}㎡ × ${x.snapshot.unitPrice} × ${x.snapshot.months} 个月`
            : x.snapshot.amount != null
              ? `固定 ${x.snapshot.amount} 元`
              : ''
          : '',
      }));
      this.setData({
        rows,
        payable: rows.filter((x) => !x.skipReason),
        skipped: rows.filter((x) => x.skipReason),
        total: r.total,
        excluded: [],
        step: 2,
      });
    } finally {
      this.setData({ previewing: false });
    }
  },

  toggleRow(e) {
    const id = e.currentTarget.dataset.id;
    const ex = this.data.excluded.includes(id)
      ? this.data.excluded.filter((x) => x !== id)
      : [...this.data.excluded, id];
    this.setData({ excluded: ex });
  },

  async generate() {
    const ids = this.scopeHouseIds();
    this.setData({ generating: true });
    try {
      const body = { ruleId: this.data.ruleId, period: this.data.period };
      if (ids) body.onlyHouseIds = ids;
      if (this.data.excluded.length) body.excludeHouseIds = this.data.excluded;
      const r = await adminRequest('/admin/bill-runs', { method: 'POST', data: body });
      if (r.alreadyPublished) {
        wx.showModal({
          title: '本期已发布',
          content: '这条标准这个月的账单已经发布过,无法再往同一批里追加。如需补账请改用下一个账期,或在电脑后台用「导入账单」单独出一批。',
          showCancel: false,
        });
        return;
      }
      // 拉批次合计:发布按钮上必须显示真实的户数与金额,不能拿预览的数字充数
      const bills = await adminRequest(`/admin/bills?batchId=${r.batchId}&page=1&pageSize=1`, { silent: true });
      const batches = await adminRequest(`/admin/bill-batches?period=${this.data.period}&pageSize=50`, { silent: true });
      const b = (batches.list || []).find((x) => x.id === r.batchId);
      this.setData({
        batch: {
          id: r.batchId,
          generated: r.generated,
          skipped: r.skipped,
          count: b ? b.validRows : bills.total,
          total: b ? b.totalAmount : null,
          published: b ? b.status === 'PUBLISHED' : false,
        },
        step: 3,
      });
    } finally {
      this.setData({ generating: false });
    }
  },

  async publish() {
    const b = this.data.batch;
    if (!b) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '发布账单',
        content: `发布后 ${b.count} 户业主立即能在小程序看到这笔账单并缴费${b.total ? `,合计 ¥${b.total}` : ''}。确认发布?`,
        confirmText: '发布',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;
    this.setData({ publishing: true });
    try {
      await adminRequest(`/admin/bill-batches/${b.id}/publish`, {
        method: 'POST',
        data: { requestId: `mp-publish-${b.id}` },
      });
      wx.showToast({ title: '已发布,业主可见', icon: 'success' });
      this.setData({ batch: { ...b, published: true } });
    } finally {
      this.setData({ publishing: false });
    }
  },

  backToScope() {
    this.setData({ step: 1, rows: [], batch: null });
  },

  onUnload() {
    clearTimeout(this._t);
  },
});
