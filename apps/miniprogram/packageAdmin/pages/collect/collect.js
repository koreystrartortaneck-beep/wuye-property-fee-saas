const { adminRequest } = require('../../../utils/admin');

/*
 * 线下收款登记 —— 业主拿现金/扫收款码到物业交钱,把这笔记到账单上。
 *
 * 这是物业每天按得最多的一下,所以它必须:
 *   · 金额不给改。金额来自账单,收多少是账单说的,不是柜台说的。
 *     (系统本身也只支持整笔核销,给个输入框等于骗人)
 *   · 单据号必填。收据本编号/转账凭证号是这笔现金**唯一的**线下痕迹,
 *     以后对不上账时只能靠它回到纸面。
 *   · 重复提交不重复收款。requestId 由「账单 + 单据号」拼出:
 *     手抖点两下是同一次(服务端重放返回同一张收据),
 *     换了单据号才算另一次(那是真的改单)。
 *   · 收完把收据号显示出来。业主会问「有凭证吗」。
 */

const METHODS = ['现金', '微信收款码', '银行转账', '其他'];

Page({
  data: {
    billId: '',
    houseId: '',
    loading: true,
    loadError: '',
    bill: null,
    methods: METHODS,
    method: '现金',
    voucherNo: '',
    paidAt: '',
    /** 日期选择上限:钱不可能在未来收到 */
    today: '',
    payerName: '',
    remark: '',
    submitting: false,
    result: null,
  },

  onLoad(q) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    this.setData({ billId: q.billId || '', houseId: q.houseId || '', paidAt: today, today });
    void this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: '' });
    try {
      /*
       * 金额必须现查一遍。
       * 上一页的数字可能已经过时(别人刚在电脑上收过、或账单被作废),
       * 拿着过时的金额收现金是真金白银的错。
       */
      const d = await adminRequest(
        `/admin/bills?houseId=${this.data.houseId}&status=UNPAID&page=1&pageSize=200`,
        { silent: true },
      );
      const bill = (d.list || []).find((x) => x.id === this.data.billId);
      if (!bill) {
        this.setData({ loadError: '没找到这笔待缴账单 —— 它可能刚被收过、已作废,或这户待缴账单超过 200 笔。请返回刷新后再看。' });
        return;
      }
      const name = (bill.house && (bill.house.displayName || bill.house.code)) || '';
      this.setData({
        bill: { ...bill, houseName: name },
        voucherNo: this.data.voucherNo || suggestVoucher(this.data.method, bill.house && bill.house.code),
      });
    } catch (e) {
      this.setData({ loadError: '加载失败,请检查网络后重试' });
    } finally {
      this.setData({ loading: false });
    }
  },

  pickMethod(e) {
    const method = METHODS[Number(e.currentTarget.dataset.i)];
    const code = this.data.bill && this.data.bill.house ? this.data.bill.house.code : '';
    this.setData({ method, voucherNo: suggestVoucher(method, code) });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.k]: e.detail.value });
  },

  onPaidAt(e) {
    this.setData({ paidAt: e.detail.value });
  },

  async submit() {
    const b = this.data.bill;
    if (!b || this.data.submitting) return;
    const voucherNo = this.data.voucherNo.trim();
    if (!voucherNo) return wx.showToast({ title: '请填单据号', icon: 'none' });

    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '确认收到钱',
        content: `${b.houseName} · ${b.title}\n收 ¥${b.amount}(${this.data.method})\n单据号 ${voucherNo}\n\n确认后这笔账单立刻变「已缴」,业主端也会显示已缴。`,
        confirmText: '确认收款',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;

    this.setData({ submitting: true });
    try {
      const r = await adminRequest('/admin/payments/offline', {
        method: 'POST',
        data: {
          billId: this.data.billId,
          voucherNo,
          paidAt: isoFor(this.data.paidAt),
          payerName: this.data.payerName.trim() || undefined,
          // 收款方式进备注:通道字段一律是 OFFLINE,方式只有写在这里才留得下来
          remark: [this.data.method, this.data.remark.trim()].filter(Boolean).join(' · ') || undefined,
          requestId: `mp-offline-${this.data.billId}-${voucherNo.replace(/\s+/g, '').slice(0, 32)}`,
        },
      });
      this.setData({ result: { orderNo: r.orderNo, receiptNo: r.receiptNo, amount: b.amount } });
    } finally {
      this.setData({ submitting: false });
    }
  },

  back() {
    wx.navigateBack();
  },
});

/** 单据号默认值:方式 + 月日 + 房号,现场只需改成收据本上的编号 */
function suggestVoucher(method, code) {
  const now = new Date();
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const tag = { 现金: 'CASH', 微信收款码: 'WXQR', 银行转账: 'BANK', 其他: 'OTHER' }[method] || 'OTHER';
  return `${tag}-${md}-${code || ''}`;
}

/*
 * 收款时间:选的是今天就用此刻(现场收款的真实时刻),
 * 补录往日则取当天正午 —— 用 00:00 在时区换算里会滑到前一天。
 */
function isoFor(day) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return day === today ? now.toISOString() : `${day}T12:00:00+08:00`;
}
