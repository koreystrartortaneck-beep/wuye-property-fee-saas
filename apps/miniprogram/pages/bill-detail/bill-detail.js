const { request } = require('../../utils/request');

const STATUS_LABEL = { UNPAID: '待缴', PAID: '已缴', CANCELED: '已作废' };
const METER_LABEL = { WATER: '水表', ELEC: '电表', GAS: '燃气表' };
const SHARE_LABEL = { AREA: '按面积分摊', HOUSE: '按户均分' };

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
    const overdue = b.status === 'UNPAID' && new Date(b.dueDate) < new Date();
    this.setData({
      bill: {
        id: b.id,
        title: b.title,
        period: b.period,
        amount: Number(b.amount).toFixed(2),
        status: b.status,
        statusLabel: overdue ? '已逾期' : STATUS_LABEL[b.status] || b.status,
        houseName: b.house ? b.house.displayName : '',
        dueDate: (b.dueDate || '').slice(0, 10),
        paidAt: b.paidAt ? b.paidAt.replace('T', ' ').slice(0, 16) : '',
      },
      calcRows,
      overdue,
    });
  },

  goPay() {
    const b = this.data.bill;
    if (!b || b.status !== 'UNPAID') return;
    // 单账单单支付：由确认页向后端复核金额与收款状态后下单
    wx.navigateTo({ url: `/pages/pay-confirm/pay-confirm?billId=${b.id}` });
  },
});
