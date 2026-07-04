const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');

const TYPE_LABEL = { REPAIR: '报修', COMPLAINT: '投诉', SUGGESTION: '建议' };
const STATUS_LABEL = { PENDING: '待受理', PROCESSING: '处理中', DONE: '已办结', CLOSED: '已关闭' };

Page({
  data: {
    ticket: null,
    timeline: [],
    ratingInput: 0,
    ratingComment: '',
    submittingRate: false,
  },

  async onLoad(options) {
    this.id = options.id;
    await getApp().loginReady;
    await this.load();
  },

  async load() {
    const t = await request(`/owner/tickets/${this.id}`);
    const fmt = (s) => (s ? s.replace('T', ' ').slice(0, 16) : '');
    const timeline = [{ label: '提交工单', time: fmt(t.createdAt), done: true }];
    timeline.push({
      label: t.assigneeName ? `物业受理（${t.assigneeName}）` : '物业受理',
      time: fmt(t.processedAt),
      done: !!t.processedAt,
    });
    if (t.status === 'CLOSED') {
      timeline.push({ label: '已关闭', time: '', done: true });
    } else {
      timeline.push({ label: '处理完成', time: fmt(t.doneAt), done: !!t.doneAt });
    }
    this.setData({
      ticket: {
        id: t.id,
        typeLabel: TYPE_LABEL[t.type] || t.type,
        statusLabel: STATUS_LABEL[t.status] || t.status,
        status: t.status,
        content: t.content,
        images: (t.images || []).map(imageUrl),
        replyContent: t.replyContent,
        rating: t.rating,
        ratingComment: t.ratingComment,
        houseName: t.house ? `${t.house.community.name} ${t.house.displayName}` : '',
        time: fmt(t.createdAt),
      },
      timeline,
    });
  },

  previewImage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: this.data.ticket.images,
    });
  },

  setRating(e) {
    this.setData({ ratingInput: Number(e.currentTarget.dataset.star) });
  },

  onRatingComment(e) {
    this.setData({ ratingComment: e.detail.value });
  },

  async submitRating() {
    if (this.data.submittingRate) return;
    if (!this.data.ratingInput) {
      wx.showToast({ title: '请点亮星星评分', icon: 'none' });
      return;
    }
    this.setData({ submittingRate: true });
    try {
      await request(`/owner/tickets/${this.id}/rate`, {
        method: 'POST',
        data: { rating: this.data.ratingInput, comment: this.data.ratingComment.trim() || undefined },
      });
      wx.showToast({ title: '感谢您的评价', icon: 'success' });
      await this.load();
    } finally {
      this.setData({ submittingRate: false });
    }
  },
});
