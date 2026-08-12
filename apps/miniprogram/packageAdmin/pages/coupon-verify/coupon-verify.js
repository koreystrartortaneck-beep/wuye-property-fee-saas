const { adminRequest } = require('../../../utils/admin');

/*
 * 卡券核销 —— 前台动线:业主亮码 → 输码(或粘贴) → 看清是什么券、什么状态 → 确认核销。
 *
 * 为什么先查再核,而不是一键核:核销是不可逆的(核了东西就发出去了),
 * 必须先把「这是谁的什么券、还能不能用」摆在眼前再让人按确认。
 * 并发防线在服务端(条件 updateMany):两个前台同时核同一张,只有一个成功,
 * 另一个得到「刚刚已被核销」—— 东西不会发两份。
 */

const STATUS = { UNUSED: '未使用', USED: '已核销', EXPIRED: '已过期' };
const TYPE = { DISCOUNT: '抵扣券', SERVICE: '服务券', GIFT: '礼品券' };

Page({
  data: {
    code: '',
    checking: false,
    verifying: false,
    /** 查到的券;null = 还没查/没找到 */
    found: null,
    error: '',
  },

  onInput(e) {
    this.setData({ code: e.detail.value, found: null, error: '' });
  },

  async lookup() {
    const code = this.data.code.trim();
    if (!code) return wx.showToast({ title: '请输入券码', icon: 'none' });
    this.setData({ checking: true, found: null, error: '' });
    try {
      const uc = await adminRequest(`/admin/coupons/verify/${encodeURIComponent(code)}`, { silent: true });
      const expired = uc.coupon && uc.coupon.validTo && new Date(uc.coupon.validTo) < new Date();
      this.setData({
        found: {
          code,
          name: uc.coupon ? uc.coupon.name : '',
          typeLabel: TYPE[uc.coupon && uc.coupon.type] || '',
          faceValue: uc.coupon && uc.coupon.faceValue ? uc.coupon.faceValue : '',
          validTo: uc.coupon && uc.coupon.validTo ? String(uc.coupon.validTo).slice(0, 10) : '',
          statusLabel: uc.status === 'USED' ? STATUS.USED : expired ? STATUS.EXPIRED : STATUS.UNUSED,
          usable: uc.status === 'UNUSED' && !expired,
          usedAt: uc.usedAt ? String(uc.usedAt).slice(0, 16).replace('T', ' ') : '',
        },
      });
    } catch (e) {
      this.setData({ error: (e && e.message) || '没查到这张券,核对一下券码' });
    } finally {
      this.setData({ checking: false });
    }
  },

  async verify() {
    const f = this.data.found;
    if (!f || !f.usable || this.data.verifying) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '确认核销',
        content: `「${f.name}」核销后立即失效,不能撤销。确认业主已当面兑换?`,
        confirmText: '核销',
        success: (r) => resolve(r.confirm),
        // 弹窗失败也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    this.setData({ verifying: true });
    try {
      await adminRequest(`/admin/coupons/verify/${encodeURIComponent(f.code)}`, { method: 'POST', silent: true });
      wx.showToast({ title: '已核销', icon: 'success' });
      this.setData({ found: { ...f, usable: false, statusLabel: STATUS.USED } });
    } catch (e) {
      // 常见:另一个前台刚核掉了。服务端的话已经说清,原样给人看。
      wx.showModal({ title: '没有核销', content: (e && e.message) || '核销失败,请重试', showCancel: false });
    } finally {
      this.setData({ verifying: false });
    }
  },
});
