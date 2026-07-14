const { request } = require('../../utils/request');
const { uploadImage } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');

const TYPE_TABS = [
  { value: 'REPAIR', label: '报修' },
  { value: 'COMPLAINT', label: '投诉' },
  { value: 'SUGGESTION', label: '建议' },
];

const PLACEHOLDER = {
  REPAIR: '请描述故障情况和位置，如：厨房水管接口漏水…',
  COMPLAINT: '请描述您要反映的问题…',
  SUGGESTION: '欢迎提出您的建议…',
};

Page({
  data: {
    typeTabs: TYPE_TABS,
    typeIndex: 0,
    placeholder: PLACEHOLDER.REPAIR,
    content: '',
    images: [], // 本地临时路径
    houses: [],
    houseIndex: 0,
    submitting: false,
    noHouse: false,
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  async onLoad(options) {
    // 从「我的-投诉建议」进入时带 type
    if (options.type) {
      const idx = TYPE_TABS.findIndex((t) => t.value === options.type);
      if (idx >= 0) this.setData({ typeIndex: idx, placeholder: PLACEHOLDER[options.type] });
    }
    await getApp().loginReady;
    let houses = [];
    try {
      houses = await loadMyHouses();
    } catch (e) {
      houses = getApp().globalData.houses || [];
    }
    const current = getApp().globalData.currentHouse;
    const houseIndex = Math.max(0, houses.findIndex((h) => current && h.houseId === current.houseId));
    this.setData({ houses, houseIndex, noHouse: houses.length === 0 });
  },

  setType(e) {
    const idx = Number(e.currentTarget.dataset.index);
    this.setData({ typeIndex: idx, placeholder: PLACEHOLDER[TYPE_TABS[idx].value] });
  },

  onContent(e) {
    this.setData({ content: e.detail.value });
  },

  onHouseChange(e) {
    this.setData({ houseIndex: Number(e.detail.value) });
  },

  chooseImage() {
    const remain = 3 - this.data.images.length;
    if (remain <= 0) return;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      success: (res) => {
        this.setData({ images: this.data.images.concat(res.tempFiles.map((f) => f.tempFilePath)) });
      },
    });
  },

  removeImage(e) {
    const images = [...this.data.images];
    images.splice(Number(e.currentTarget.dataset.index), 1);
    this.setData({ images });
  },

  async submit() {
    const { content, houses, houseIndex, typeIndex, images, submitting } = this.data;
    if (submitting) return;
    if (houses.length === 0) {
      wx.showToast({ title: '请先绑定房屋', icon: 'none' });
      return;
    }
    if (!content.trim()) {
      wx.showToast({ title: '请填写内容', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: images.length ? '上传图片中' : '提交中', mask: true });
    try {
      // 传图与建单解耦：失败的图片跳过，不阻断建单
      let urls = [];
      if (images.length) {
        const results = await Promise.allSettled(images.map((p) => uploadImage(p)));
        urls = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        const failed = results.length - urls.length;
        if (failed > 0) {
          wx.hideLoading();
          const go = await new Promise((resolve) =>
            wx.showModal({
              title: '部分图片上传失败',
              content: `有 ${failed} 张图片没传上。是否继续提交（仅保留已成功的图片）？`,
              confirmText: '继续提交',
              cancelText: '返回重试',
              success: (m) => resolve(m.confirm),
              fail: () => resolve(false),
            })
          );
          if (!go) {
            this.setData({ submitting: false });
            return;
          }
          wx.showLoading({ title: '提交中', mask: true });
        }
      }
      await request('/owner/tickets', {
        method: 'POST',
        data: {
          houseId: houses[houseIndex].houseId,
          type: TYPE_TABS[typeIndex].value,
          content: content.trim(),
          images: urls,
        },
      });
      wx.hideLoading();
      wx.showModal({
        title: '提交成功',
        content: '物业受理后可在「我的工单」查看进度',
        showCancel: false,
        success: () => wx.redirectTo({ url: '/pages/tickets/tickets' }),
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  },
});
