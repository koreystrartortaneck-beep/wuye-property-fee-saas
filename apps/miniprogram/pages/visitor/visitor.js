const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');

const STATUS_LABEL = { ACTIVE: '有效', USED: '已使用', EXPIRED: '已过期', CANCELED: '已取消' };

function todayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    houses: [],
    houseIndex: 0,
    visitorName: '',
    plateNo: '',
    visitDate: '',
    todayStr: '',
    list: [],
    submitting: false,
  },

  async onShow() {
    await getApp().loginReady;
    const houses = await loadMyHouses().catch(() => []);
    const current = getApp().globalData.currentHouse;
    const houseIndex = Math.max(0, houses.findIndex((h) => current && h.houseId === current.houseId));
    this.setData({ houses, houseIndex, visitDate: this.data.visitDate || todayStr(), todayStr: todayStr() });
    await this.loadList();
  },

  async loadList() {
    const res = await request('/owner/visitor-passes?pageSize=20');
    this.setData({
      list: res.list.map((p) => ({
        id: p.id,
        code: p.code,
        visitorName: p.visitorName,
        plateNo: p.plateNo,
        date: (p.visitDate || '').slice(0, 10),
        houseName: p.house ? `${p.house.community.name} ${p.house.displayName}` : '',
        status: p.status,
        statusLabel: STATUS_LABEL[p.status] || p.status,
      })),
    });
  },

  onName(e) { this.setData({ visitorName: e.detail.value }); },
  onPlate(e) { this.setData({ plateNo: e.detail.value }); },
  onDate(e) { this.setData({ visitDate: e.detail.value }); },
  onHouseChange(e) { this.setData({ houseIndex: Number(e.detail.value) }); },

  async create() {
    const { houses, houseIndex, visitorName, plateNo, visitDate, submitting } = this.data;
    if (submitting) return;
    if (houses.length === 0) return wx.showToast({ title: '请先绑定房屋', icon: 'none' });
    if (!visitorName.trim()) return wx.showToast({ title: '请填写访客姓名', icon: 'none' });
    this.setData({ submitting: true });
    try {
      const pass = await request('/owner/visitor-passes', {
        method: 'POST',
        data: {
          houseId: houses[houseIndex].houseId,
          visitorName: visitorName.trim(),
          plateNo: plateNo.trim() || undefined,
          visitDate,
        },
      });
      this.setData({ visitorName: '', plateNo: '' });
      wx.showModal({
        title: '通行码已生成',
        content: `${pass.code}\n请转发给访客，到访时向物业出示`,
        showCancel: false,
      });
      await this.loadList();
    } finally {
      this.setData({ submitting: false });
    }
  },

  copyCode(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.code });
  },

  async cancel(e) {
    const id = e.currentTarget.dataset.id;
    const confirm = await new Promise((resolve) =>
      wx.showModal({ title: '取消该通行码？', success: (r) => resolve(r.confirm) }),
    );
    if (!confirm) return;
    await request(`/owner/visitor-passes/${id}/cancel`, { method: 'POST' });
    await this.loadList();
  },
});
