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
  },

  async onLoad(options) {
    // 从「我的-投诉建议」进入时带 type
    if (options.type) {
      const idx = TYPE_TABS.findIndex((t) => t.value === options.type);
      if (idx >= 0) this.setData({ typeIndex: idx, placeholder: PLACEHOLDER[options.type] });
    }
    await getApp().loginReady;
    const houses = await loadMyHouses().catch(() => []);
    const current = getApp().globalData.currentHouse;
    const houseIndex = Math.max(0, houses.findIndex((h) => current && h.houseId === current.houseId));
    this.setData({ houses, houseIndex });
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
    wx.showLoading({ title: '提交中' });
    try {
      // 先传图，再建单
      const urls = [];
      for (const path of images) urls.push(await uploadImage(path));
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
