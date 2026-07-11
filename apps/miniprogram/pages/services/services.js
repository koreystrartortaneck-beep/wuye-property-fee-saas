const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');

const ORDER_STATUS = { PENDING: '待接单', ACCEPTED: '已接单', DONE: '已完成', CANCELED: '已取消' };

Page({
  data: {
    tab: 0, // 0 服务菜单 1 我的预约
    items: [],
    orders: [],
  },

  onLoad(options) {
    if (options && options.tab === '1') this.setData({ tab: 1 });
  },

  async onShow() {
    await getApp().loginReady;
    await loadMyHouses().catch(() => []);
    await this.loadItems();
    if (this.data.tab === 1) await this.loadOrders();
  },

  async loadItems() {
    const house = getApp().globalData.currentHouse;
    if (!house) {
      this.setData({ items: [] });
      return;
    }
    const list = await request(`/owner/service-items?houseId=${house.houseId}`);
    this.setData({
      items: list.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category || '',
        price: Number(s.price).toFixed(0),
        unit: s.unit,
        desc: s.description || '',
        cover: s.coverImage ? imageUrl(s.coverImage) : '',
      })),
    });
  },

  async loadOrders() {
    const res = await request('/owner/service-orders?pageSize=30');
    this.setData({
      orders: res.list.map((o) => ({
        id: o.id,
        name: o.serviceName,
        price: Number(o.price).toFixed(0),
        unit: o.unit,
        date: (o.expectDate || '').slice(0, 10),
        remark: o.remark || '',
        status: o.status,
        statusLabel: ORDER_STATUS[o.status] || o.status,
      })),
    });
  },

  async switchTab(e) {
    const tab = Number(e.currentTarget.dataset.tab);
    this.setData({ tab });
    if (tab === 1) await this.loadOrders();
  },

  book(e) {
    const item = this.data.items[Number(e.currentTarget.dataset.index)];
    getApp().globalData.bookingItem = item;
    wx.navigateTo({ url: `/pages/service-book/service-book?id=${item.id}` });
  },

  async cancelOrder(e) {
    const id = e.currentTarget.dataset.id;
    const ok = await new Promise((r) => wx.showModal({ title: '取消该预约？', success: (res) => r(res.confirm) }));
    if (!ok) return;
    await request(`/owner/service-orders/${id}/cancel`, { method: 'POST' });
    await this.loadOrders();
  },
});
