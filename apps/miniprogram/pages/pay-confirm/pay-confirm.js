const share = require('../../utils/share');
const { request } = require('../../utils/request');
const { maybeRequestSubscribe } = require('../../utils/subscribe');
const { waitForPaymentConfirmation } = require('../../utils/payment');

Page({
  // 转发/朋友圈:没有这两个回调,菜单里的分享是灰的(2026-08-15 实测)
  onShareAppMessage: share.onShareAppMessage,
  onShareTimeline: share.onShareTimeline,

  data: {
    billId: '',
    house: '',
    title: '',
    totalAmount: '0.00',
    paused: false,
    pausedReason: '',
    payable: false,
    pendingOrder: false,
    billStatus: '',
    // 优惠券抵扣
    coupons: [],
    pickedCouponId: '',
    discount: '0.00',
    payAmount: '0.00',
    loaded: false,
    paying: false,
    // 幂等请求标识：同一次缴费动作的重试复用同一 requestId
    requestId: '',
  },

  onLoad(query) {
    const billId = (query && query.billId) || '';
    if (!billId) {
      wx.showToast({ title: '没有选中账单,请从账单列表点「缴费」进入', icon: 'none', duration: 3000 });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 每次进入确认页生成一个稳定的幂等键，供重试复用
    const requestId = `pay-${billId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.setData({ billId, requestId });
    this.refreshQuote();
  },

  /** 向后端复核账单权威金额与分层收款状态，不信任本地缓存 */
  async refreshQuote() {
    try {
      const quote = await request(`/owner/payments/quote/${this.data.billId}`);
      const paused = quote.collection && quote.collection.status === 'PAUSED';
      this.setData({
        loaded: true,
        title: quote.title,
        totalAmount: Number(quote.amount).toFixed(2),
        house: quote.house ? `${quote.house.communityName} ${quote.house.displayName}` : '',
        paused,
        pausedReason: (quote.collection && quote.collection.reason) || '',
        // 后端已返回 pendingOrder（该账单被进行中订单占用），此前被丢弃，
        // 业主上次支付中断后再进来只看到「暂不可缴费」而无任何指引。
        pendingOrder: !!quote.pendingOrder,
        billStatus: quote.status || '',
        payable: quote.payable,
        coupons: quote.usableCoupons || [],
      });
      this.recalc();
    } catch (e) {
      wx.showToast({ title: '账单加载失败,请返回上一页重试', icon: 'none', duration: 3000 });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  /**
   * 选择/取消优惠券。
   *
   * 兜底：若某张券会把实付降到 0，后端 createPayment 会拒（微信不接受 0 元订单，
   * 那个错误还会让订单卡进 PREPAY_UNKNOWN、账单被占用、券被消耗）。后端 quoteBill
   * 已经不再返回这类券，但万一遇到旧版后端，这里不能让业主看着「确认支付 ¥0.00」
   * 点下去才被拒——当场说清并取消选择。
   */
  pickCoupon(e) {
    const id = e.currentTarget.dataset.id || '';
    const next = this.data.pickedCouponId === id ? '' : id;
    if (next) {
      const total = Number(this.data.totalAmount) || 0;
      const picked = (this.data.coupons || []).find((c) => c.userCouponId === next);
      const discount = picked ? Math.min(Number(picked.discount) || 0, total) : 0;
      if (total - discount <= 0) {
        wx.showModal({
          title: '这张券暂不能用在本单',
          content: '该券面额已覆盖本单全部金额，微信不支持 0 元支付。请把它用在金额更高的账单上。',
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }
    }
    this.setData({ pickedCouponId: next });
    this.recalc();
  },

  /** 按所选券重算实付金额（抵扣不超过账单金额，且实付必须为正——见 pickCoupon 说明） */
  recalc() {
    const total = Number(this.data.totalAmount) || 0;
    const picked = (this.data.coupons || []).find((c) => c.userCouponId === this.data.pickedCouponId);
    const discount = picked ? Math.min(Number(picked.discount) || 0, total) : 0;
    const payAmount = total - discount;
    // 实付非正时视为未选券，绝不显示「确认支付 ¥0.00」
    if (payAmount <= 0) {
      this.setData({ pickedCouponId: '', discount: '0.00', payAmount: total.toFixed(2) });
      return;
    }
    this.setData({ discount: discount.toFixed(2), payAmount: payAmount.toFixed(2) });
  },

  async submitPay() {
    if (this.data.paying) return;
    if (!this.data.payable) {
      wx.showToast({ title: this.data.paused ? '当前收款已暂停' : '该账单暂不可缴费', icon: 'none' });
      return;
    }
    this.setData({ paying: true });
    /*
     * 请求订阅缴费提醒。必须在点击手势上下文里同步发起，所以放在最前面，
     * 且不阻断支付（拒绝/失败都静默）。
     * 用 maybeRequestSubscribe：7 天内最多问一次，被微信禁用后不再问 ——
     * 这是全小程序唯一还会主动弹授权框的地方（另一处是业主自己点的开关）。
     */
    await maybeRequestSubscribe().catch(() => {});
    wx.showLoading({ title: '支付中' });
    let order = null;
    try {
      order = await request('/owner/payments', {
        method: 'POST',
        data: {
          billId: this.data.billId,
          requestId: this.data.requestId,
          userCouponId: this.data.pickedCouponId || undefined,
        },
      });
      if (order.payParams && order.payParams.mock) {
        // mock 模式：直接确认
        await request(`/owner/payments/${order.orderNo}/mock-confirm`, { method: 'POST' });
      } else if (order.payParams) {
        wx.hideLoading();
        await new Promise((resolve, reject) =>
          wx.requestPayment({ ...order.payParams, success: resolve, fail: reject }),
        );
        /*
         * 到这一行，微信已经确认扣款成功 —— 这是权威结论，业主的支付已经完成。
         *
         * 原来这里会 showLoading('确认支付结果') 并等我们自己的入账完成，
         * 等不到就弹一个「已收到您的支付…」的框。那是把两件不同的事混成了一件：
         *   · 「业主付了吗」—— 微信当场就答了
         *   · 「我们记上了吗」—— 是我们的内部记账，不该由业主承担这段等待
         * 结果业主付完款先看到转圈、再看到一个解释性弹框，而他要的只是「缴清了」。
         * 2026-08-01 事故里这段等待最长拖了 42 分钟。
         *
         * 现在立刻进成功页。入账确认改成后台推进：
         *   · 这里 fire-and-forget 触发一次查单，让入账尽快发生
         *   · 成功页自己安静地轮询，凭证/发票入口就绪后再点亮
         *   · 账单列表对这种「已付款未入账」的账单显示「入账中」，不再显示「未缴」
         */
        waitForPaymentConfirmation(order.orderNo).catch(() => {});
      } else {
        // 无 payParams（如预下单结果不确定 PREPAY_UNKNOWN）：提示稍后查看
        wx.hideLoading();
        await new Promise((resolve) => wx.showModal({
          title: '支付结果确认中',
          content: '请稍后在缴费记录中查看最终结果',
          showCancel: false,
          complete: resolve,
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }));
        this.setData({ paying: false });
        return;
      }
      wx.hideLoading();
      wx.redirectTo({ url: `/pages/pay-success/pay-success?orderNo=${order.orderNo}` });
    } catch (e) {
      wx.hideLoading();
      if (order && order.payParams && !order.payParams.mock) {
        try {
          const result = await request(`/owner/payments/${order.orderNo}/cancel`, {
            method: 'POST',
            silent: true,
          });
          if (result.status === 'SUCCESS') {
            wx.redirectTo({ url: `/pages/pay-success/pay-success?orderNo=${order.orderNo}` });
            return;
          }
          if (result.status === 'CLOSED') {
            // 本次尝试已终结：必须换新的幂等键，否则再点支付会命中后端幂等重放，
            // 拿回这张已关闭订单的旧 payParams（prepay_id 亦一次性），支付必然失败，
            // 业主被困在「支付已取消」死循环里，只能退出页面重进。
            this.resetRequestId();
            wx.showToast({ title: '支付已取消', icon: 'none' });
          }
        } catch (_) {
          wx.showModal({
            title: '支付结果待确认',
            content: '请稍后在缴费记录中查看最终结果',
            showCancel: false,
          });
        }
      } else if (!order) {
        // 建单本身失败：幂等记录已落 FAILED 终态，同键重试只会重放同一错误，
        // 同样需要换键才能真正重试。
        this.resetRequestId();
      }
      this.setData({ paying: false });
    }
  },

  /** 开始一次新的支付尝试：换幂等键。同一次尝试内的网络重试仍复用同一键。 */
  resetRequestId() {
    this.setData({
      requestId: `pay-${this.data.billId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
  },
});
