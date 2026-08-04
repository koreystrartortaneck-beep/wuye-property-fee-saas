const { adminRequest } = require('../../../utils/admin');

/*
 * 发账单(手机端)—— 批量:全部 / 按楼栋。
 *
 * 单独一户不走这里:从楼盘图点进那一户,页面底部「给这户发账单」直达
 * bill-one,标准和月份都替他算好。实测反馈是「点进去只想管这一户,
 * 现在非常混乱」—— 混乱的根源就是把单户塞进了批量流程,
 * 让人为了一户去选标准、选月份、选范围,选错一个就是「0 户可出账」。
 *
 * 流程是「先看后发」,一步都不省:
 *   选标准+月份 → 预览逐行金额与依据 → 点掉不该出的 → 生成草稿(业主看不见)
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
    /** 范围:all(全部) / building(按楼栋);单户走 bill-one 页 */
    scope: 'all',
    buildings: [],
    pickedBuilding: '',
    /** 预览 */
    previewing: false,
    rows: [],
    payable: [],
    skipped: [],
    /** 点掉的户(houseId 数组) */
    excluded: [],
    /** 实时口径:本次真会出账的户数与合计(随剔除变动) */
    willCount: 0,
    willTotal: '0.00',
    exTotal: '0.00',
    /** 草稿 */
    generating: false,
    batch: null,
    publishing: false,
  },

  onLoad(q) {
    const now = new Date();
    this.setData({
      communityId: q.communityId || '',
      period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    });
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
      rows: [],
      batch: null,
      step: 1,
    });
  },

  pickBuilding(e) {
    this.setData({ pickedBuilding: e.currentTarget.dataset.b, rows: [], batch: null, step: 1 });
  },

  /** 当前范围对应的房屋 id 列表;全部 = undefined(不定向) */
  scopeHouseIds() {
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
    if (ids && ids.length === 0) return wx.showToast({ title: '请先选楼栋', icon: 'none' });
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
      this.setData(
        {
          rows,
          payable: rows.filter((x) => !x.skipReason),
          skipped: rows.filter((x) => x.skipReason),
          excluded: [],
          step: 2,
        },
        () => this.recompute(),
      );
    } finally {
      this.setData({ previewing: false });
    }
  },

  toggleRow(e) {
    const id = e.currentTarget.dataset.id;
    const ex = this.data.excluded.includes(id)
      ? this.data.excluded.filter((x) => x !== id)
      : [...this.data.excluded, id];
    this.setData({ excluded: ex }, () => this.recompute());
  },

  /*
   * 顶上那个大数字必须跟着剔除动,每一行也要看得出自己被点掉了。
   *
   * 两个坑都踩过:
   *   ① 大数字原来写死成预览返回的合计 —— 剔掉 15 户仍显示 ¥56758,
   *      人核对的是屏幕上的数字,数字不动就等于告诉他「剔除没生效」。
   *   ② 行上的勾和「本次不出」标记原来写的是 `excluded.indexOf(id) >= 0`,
   *      而 **WXML 的表达式不支持函数调用** —— 求值为空,判断恒假,
   *      于是每一行永远显示「会出账」。不报错、不告警,只是点了没反应。
   *      所以状态一律在 JS 里算成每行一个布尔值(ex)再交给 WXML。
   * 金额按分币整数相加再折算,不拿字符串金额做浮点累加。
   */
  recompute() {
    const set = {};
    for (const id of this.data.excluded) set[id] = true;
    let cents = 0;
    let exCents = 0;
    let n = 0;
    const payable = this.data.payable.map((r) => {
      const c = r.amountCents || 0;
      const ex = !!set[r.houseId];
      if (ex) exCents += c;
      else {
        cents += c;
        n += 1;
      }
      return { ...r, ex };
    });
    this.setData({
      payable,
      willCount: n,
      willTotal: (cents / 100).toFixed(2),
      exTotal: (exCents / 100).toFixed(2),
    });
  },

  async generate() {
    if (this.data.willCount === 0) {
      return wx.showToast({ title: '这次一户都没选,没什么可生成', icon: 'none' });
    }
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
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
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
});
