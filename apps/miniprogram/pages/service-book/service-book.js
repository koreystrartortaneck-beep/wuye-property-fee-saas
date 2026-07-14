const { request } = require('../../utils/request');

function todayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    item: null,
    contactName: '',
    contactPhone: '',
    expectDate: '',
    todayStr: '',
    remark: '',
    submitting: false,
  },

  onLoad(options) {
    const item = getApp().globalData.bookingItem;
    // globalData 可能被微信回收清空，兜底用 URL 的 id
    this.itemId = (item && item.id) || (options && options.id) || '';
    this.setData({ item: item || null, expectDate: todayStr(1), todayStr: todayStr() });
  },

  onName(e) { this.setData({ contactName: e.detail.value }); },
  onPhone(e) { this.setData({ contactPhone: e.detail.value }); },
  onDate(e) { this.setData({ expectDate: e.detail.value }); },
  onRemark(e) { this.setData({ remark: e.detail.value }); },

  async submit() {
    const { contactName, contactPhone, expectDate, remark, submitting } = this.data;
    if (submitting) return;
    const house = getApp().globalData.currentHouse;
    if (!house) return wx.showToast({ title: '请先绑定房屋', icon: 'none' });
    if (!this.itemId) return wx.showToast({ title: '服务信息已失效，请重新选择', icon: 'none' });
    if (!contactName.trim()) return wx.showToast({ title: '请填写联系人', icon: 'none' });
    if (!/^1\d{10}$/.test(contactPhone)) return wx.showToast({ title: '请填写正确手机号', icon: 'none' });
    this.setData({ submitting: true });
    try {
      await request('/owner/service-orders', {
        method: 'POST',
        data: {
          houseId: house.houseId,
          serviceItemId: this.itemId,
          contactName: contactName.trim(),
          contactPhone: contactPhone.trim(),
          expectDate,
          remark: remark.trim() || undefined,
        },
      });
      wx.showModal({
        title: '预约成功',
        content: '物业接单后会电话联系您确认上门时间',
        showCancel: false,
        success: () => wx.redirectTo({ url: '/pages/services/services?tab=1' }),
      });
    } catch (e) {
      this.setData({ submitting: false });
    }
  },
});
