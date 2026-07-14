const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');

const ORDER_STATUS = { PENDING: '待接单', ACCEPTED: '已接单', DONE: '已完成', CANCELED: '已取消' };

Page({
  data: {
    tab: 0, // 0 服务菜单 1 我的预约
    items: [],
    orders: [],
    loading: true,
    error: false,
    noHouse: false,
    ordersLoading: false,
    ordersError: false,
  },

  onLoad(options) {
    if (options && options.tab === '1') this.setData({ tab: 1 });
  },

  async onShow() {
    await getApp().loginReady;
    await this.loadItems();
    if (this.data.tab === 1) await this.loadOrders();
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  retry() {
    this.loadItems();
  },

  retryOrders() {
    this.loadOrders();
  },

  async loadItems() {
    this.setData({ loading: this.data.items.length === 0, error: false });
    try {
      const houses = await loadMyHouses();
      const house = getApp().globalData.currentHouse;
      if (!houses.length || !house) {
        this.setData({ noHouse: true, items: [], loading: false, error: false });
        return;
      }
      const list = await request(`/owner/service-items?houseId=${house.houseId}`, { silent: true });
      this.setData({
        noHouse: false,
        loading: false,
        error: false,
        items: (list || []).map((s) => ({
          id: s.id,
          name: s.name || '服务',
          category: s.category || '',
          price: Number(s.price || 0).toFixed(2),
          unit: s.unit || '',
          desc: s.description || '',
          cover: s.coverImage ? imageUrl(s.coverImage) : '',
        })),
      });
    } catch (e) {
      // 请求失败（区别于"确实没房"）：有数据则保留，无数据则显示错误态
      this.setData({ loading: false, error: this.data.items.length === 0 });
    }
  },

  async loadOrders() {
    this.setData({ ordersLoading: this.data.orders.length === 0, ordersError: false });
    try {
      const res = await request('/owner/service-orders?pageSize=30', { silent: true });
      this.setData({
        ordersLoading: false,
        ordersError: false,
        orders: (res.list || []).map((o) => ({
          id: o.id,
          name: o.serviceName || '',
          price: Number(o.price || 0).toFixed(2),
          unit: o.unit || '',
          date: (o.expectDate || '').slice(0, 10),
          remark: o.remark || '',
          status: o.status,
          statusLabel: ORDER_STATUS[o.status] || o.status,
        })),
      });
    } catch (e) {
      this.setData({ ordersLoading: false, ordersError: this.data.orders.length === 0 });
    }
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
