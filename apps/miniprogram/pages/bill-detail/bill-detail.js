const { request } = require('../../utils/request');
const labels = require('../../utils/labels');
const { fmtDate, fmtDateTime } = require('../../utils/datetime');
const STATUS_LABEL = labels.BILL_STATUS;
const METER_LABEL = labels.METER_TYPE;
const SHARE_LABEL = labels.SHARE_BY;


Page({
  data: {
    bill: null,
    calcRows: [], // 计算依据 [{label, value}]
    overdue: false,
    loading: true,
    error: false,
  },

  onLoad(options) {
    this.id = options.id;
    this.load();
  },

  retry() {
    this.load();
  },

  async load() {
    if (!this.id) {
      this.setData({ loading: false, error: true });
      return;
    }
    this.setData({ loading: true, error: false });
    try {
      await getApp().loginReady;
      const b = await request(`/owner/bills/${this.id}`, { silent: true });
      this.render(b);
      this.setData({ loading: false, error: false });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },

  render(b) {
    const s = b.snapshot || {};
    const rule = b.rule || {};
    let calcRows = [];
    switch (rule.ruleType) {
      case 'AREA_PRICE':
        calcRows = [
          { label: '计费单价', value: `${s.unitPrice} 元/㎡` },
          { label: '建筑面积', value: `${s.area} ㎡` },
          { label: '计算公式', value: `${s.unitPrice} × ${s.area} = ${Number(b.amount).toFixed(2)} 元` },
        ];
        break;
      case 'FIXED':
        calcRows = [{ label: '固定费用', value: `${s.amount} 元/期` }];
        break;
      case 'METER':
        calcRows = [
          { label: '计量表', value: METER_LABEL[s.meterType] || s.meterType },
          { label: '本期用量', value: `${s.readingDiff}` },
          { label: '单价', value: `${s.unitPrice} 元/单位` },
          { label: '计算公式', value: `${s.unitPrice} × ${s.readingDiff} = ${Number(b.amount).toFixed(2)} 元` },
        ];
        break;
      case 'SHARE':
        calcRows = [
          { label: '分摊方式', value: SHARE_LABEL[s.shareBy] || s.shareBy },
          { label: '本期公摊总额', value: `${s.poolAmount} 元` },
          { label: '参与分摊户数', value: `${s.houseCount} 户` },
        ];
        break;
      case 'FORMULA':
        calcRows = [
          { label: '计费公式', value: s.expr },
          { label: '建筑面积', value: s.area ? `${s.area} ㎡` : '—' },
        ];
        break;
    }
    /*
     * settling：微信已确认扣款、我们还没销账（通常几秒）。
     * 详情页必须和列表一致：显示「入账中」，并且**收起缴费按钮** ——
     * 否则业主从列表点进来看到「待缴 + 立即缴纳」，很可能为同一笔账单付第二次。
     */
    const settling = b.status === 'UNPAID' && b.settling;
    const overdue = !settling && b.status === 'UNPAID' && new Date(b.dueDate) < new Date();
    this.setData({
      bill: {
        id: b.id,
        title: b.title,
        period: b.period,
        /*
         * 周年账单:snapshot 里有账期起止,显示「2026-03-15 ~ 2027-03-14」——
         * 业主要能看懂「这笔钱管到什么时候」;legacy 账单没有起止,照旧显示标签。
         */
        periodText:
          b.snapshot && b.snapshot.periodStart
            ? `${b.snapshot.periodStart} ~ ${b.snapshot.periodEnd}`
            : b.period,
        amount: Number(b.amount).toFixed(2),
        status: b.status,
        settling,
        statusLabel: settling ? '入账中' : overdue ? '已逾期' : STATUS_LABEL[b.status] || b.status,
        houseName: b.house ? b.house.displayName : '',
        dueDate: fmtDate(b.dueDate),
        paidAt: fmtDateTime(b.paidAt),
      },
      calcRows,
      overdue,
      settling,
    });
  },

  goPay() {
    const b = this.data.bill;
    // settling 时按钮已隐藏；这里再拦一道，防止旧数据或竞态下重复支付
    if (!b || b.status !== 'UNPAID' || b.settling) return;
    // 单账单单支付：由确认页向后端复核金额与收款状态后下单
    wx.navigateTo({ url: `/pages/pay-confirm/pay-confirm?billId=${b.id}` });
  },
});
