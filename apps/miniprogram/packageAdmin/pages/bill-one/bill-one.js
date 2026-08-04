const { adminRequest } = require('../../../utils/admin');

/*
 * 给这一户出账单 —— 单户专用,零选择。
 *
 * 实测反馈:从房屋详情点「发账单」,落到批量流程里要再选标准、再选月份、
 * 再选范围,选错一个就是「0 户可出账 ¥0.00」——「非常混乱」。
 *
 * 这一页把选择全部替它算好:
 *   标准 = 这户挂着的那条(挂了几条就列几条,通常只有一条)
 *   月份 = 这户放户日所在的月(今年)—— 周年收费的账期本来就由放户日决定,
 *          不该让人去猜「现在是几月」
 * 人只需要看一眼金额对不对,然后决定发不发。
 *
 * 发布这一步保留人工确认,而且必须说实话:草稿批次里可能还躺着别人的账单,
 * 发布是**整批**发布 —— 在单户页面上悄悄发出去 34 户是不可接受的。
 */

const SKIP_REASON = {
  HANDOVER_DATE_MISSING: '这户没填放户日期,算不出账期',
  AREA_MISSING: '这户没填建筑面积,按面积的标准算不出金额',
  ANNIVERSARY_ALREADY_BILLED: '本年度已经出过账单了',
  EXCLUDED_BY_ADMIN: '本次已剔除',
  METER_READING_MISSING: '本期没有抄表读数',
};

Page({
  data: {
    id: '',
    loading: true,
    loadError: false,
    house: null,
    /** 可出账的候选:每条挂接的标准一行 */
    candidates: [],
    pickedIndex: -1,
    /** 整套房都出不了账时的原因(如停用),连标准都不用列 */
    blockedAll: '',
    generating: false,
    publishing: false,
    /** 生成后的结果 */
    result: null,
  },

  onLoad(q) {
    this.setData({ id: q.id });
    void this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false, result: null, blockedAll: '' });
    try {
      const d = await adminRequest(`/admin/houses/${this.data.id}/standards`, { silent: true });
      const house = d.house;
      const handover = house.handoverDate ? String(house.handoverDate).slice(0, 10) : '';

      /*
       * 停用的房屋一律不出账(服务端选房时就把它过滤掉了)。
       * 必须在这里先说清楚 —— 否则预览返回空,页面只会说「这个月不该给这户出账」,
       * 而真正的原因是「这套房是停用状态」。实测把用户卡在这句话上过一次。
       * house.status 是后端新加的字段;老版本 API 没有它时不假设,走下面的通用解释。
       */
      if (house.status && house.status !== 'ACTIVE') {
        this.setData({
          house: { ...house, handoverDate: handover },
          candidates: [],
          pickedIndex: -1,
          blockedAll: '这套房现在是「停用」状态,停用的房屋不出账。要给它出账,请返回上一页 →「房屋信息 · 编辑」→ 状态改成「在用」。',
        });
        return;
      }

      const active = (d.items || []).filter(
        (s) => s.status === 'ACTIVE' && s.rule.periodScheme === 'ANNIVERSARY' && s.rule.enabled,
      );
      const nowYear = new Date().getFullYear();
      const nowMonth = new Date().getMonth() + 1;
      const candidates = [];
      for (const s of active) {
        const anchor = (s.startDate ? String(s.startDate).slice(0, 10) : '') || handover;
        if (!anchor) {
          candidates.push({
            ruleId: s.ruleId,
            ruleName: s.rule.name,
            blocked: '这户没填放户日期,算不出账期(回上一页填上就能出)',
          });
          continue;
        }
        const month = Number(anchor.slice(5, 7));
        const period = `${nowYear}-${String(month).padStart(2, '0')}`;
        const row = await this.previewOne(s.ruleId, period);
        candidates.push({
          ruleId: s.ruleId,
          ruleName: s.rule.name,
          period,
          periodText: `${nowYear} 年 ${month} 月出账`,
          // 收费月还没到:出得了,但要说清这是提前收
          early: month > nowMonth ? `这户的收费月是 ${month} 月,现在出等于提前 ${month - nowMonth} 个月收` : '',
          amount: row && row.amount ? row.amount : null,
          basis: row && row.snapshot ? basisText(row.snapshot) : '',
          rangeText: row && row.periodRange ? `账期 ${row.periodRange.start} ~ ${row.periodRange.end}` : '',
          /*
           * 预览里连这户都没出现时,别只说「不该出账」—— 那句话对着一个
           * 明明挂了标准的房子说,人只能反复点。把真实的可能性列全:
           * 停用 / 摘除 / 这条标准的锚点不在本月。
           */
          blocked: row
            ? row.skipReason
              ? SKIP_REASON[row.skipReason] || row.skipReason
              : ''
            : `这条标准算不到这户头上。可能是:房屋已停用、这条标准已被摘除,或它的账期锚点不在 ${month} 月`,
        });
      }
      const pickedIndex = candidates.findIndex((c) => !c.blocked);
      this.setData({ house: { ...house, handoverDate: handover }, candidates, pickedIndex });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 定向预览:只问这一户,与出账同口径 */
  async previewOne(ruleId, period) {
    const r = await adminRequest(
      `/admin/bill-runs/preview?ruleId=${ruleId}&period=${period}&onlyHouseIds=${this.data.id}`,
      { silent: true },
    );
    return (r.rows || []).find((x) => x.houseId === this.data.id) || null;
  },

  pickCandidate(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (this.data.candidates[i].blocked) return;
    this.setData({ pickedIndex: i, result: null });
  },

  async generate() {
    const c = this.data.candidates[this.data.pickedIndex];
    if (!c || c.blocked) return;
    this.setData({ generating: true });
    try {
      const r = await adminRequest('/admin/bill-runs', {
        method: 'POST',
        data: { ruleId: c.ruleId, period: c.period, onlyHouseIds: [this.data.id] },
      });
      if (r.alreadyPublished) {
        wx.showModal({
          title: '出不了',
          content: '这条标准这个账期的账单已经发布,系统不再往已发布的批次里追加。请在电脑后台核对。',
          showCancel: false,
        });
        return;
      }
      if (r.generated === 0) {
        const reason = r.skippedDetail && r.skippedDetail[0] ? r.skippedDetail[0].reason : '';
        wx.showModal({
          title: '没有生成',
          content: SKIP_REASON[reason] || '这户本期不该出账,请核对放户日期与收费标准。',
          showCancel: false,
        });
        return;
      }
      /*
       * 批次里现在有几户:发布是整批发布,这个数字必须取自后端批次,
       * 不能拿「我刚出了 1 户」当答案 —— 草稿批次里很可能还有本月的其他户。
       */
      const [batches, bills] = await Promise.all([
        adminRequest(`/admin/bill-batches?period=${c.period}&pageSize=50`, { silent: true }),
        adminRequest(`/admin/bills?batchId=${r.batchId}&houseId=${this.data.id}&pageSize=5`, { silent: true }),
      ]);
      const b = (batches.list || []).find((x) => x.id === r.batchId);
      const mine = (bills.list || []).find((x) => x.status !== 'CANCELED');
      this.setData({
        result: {
          batchId: r.batchId,
          batchTitle: b ? b.title : '',
          batchCount: b ? b.validRows : 1,
          batchTotal: b ? b.totalAmount : null,
          published: b ? b.status === 'PUBLISHED' : false,
          amount: mine ? mine.amount : c.amount,
          title: mine ? mine.title : c.ruleName,
        },
      });
    } finally {
      this.setData({ generating: false });
    }
  },

  async publish() {
    const r = this.data.result;
    if (!r) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '发布账单',
        content: `发布后 ${this.data.house.displayName} 的业主立即能看到这笔 ¥${r.amount} 并缴费。确认发布?`,
        confirmText: '发布',
        success: (x) => resolve(x.confirm),
      }),
    );
    if (!ok) return;
    this.setData({ publishing: true });
    try {
      await adminRequest(`/admin/bill-batches/${r.batchId}/publish`, {
        method: 'POST',
        data: { requestId: `mp-publish-${r.batchId}` },
      });
      wx.showToast({ title: '已发布,业主可见', icon: 'success' });
      this.setData({ result: { ...r, published: true } });
    } finally {
      this.setData({ publishing: false });
    }
  },

  /** 批次里还有别人 → 去整批核对页发布,不在单户页面上替他发 34 户 */
  goBatches() {
    wx.navigateTo({ url: '/packageAdmin/pages/batches/batches' });
  },

  back() {
    wx.navigateBack();
  },
});

/** 金额怎么来的,一句话讲清 */
function basisText(s) {
  if (s.months) return `${s.area}㎡ × ${s.unitPrice} 元 × ${s.months} 个月`;
  if (s.amount != null) return `固定 ${s.amount} 元`;
  return '';
}
