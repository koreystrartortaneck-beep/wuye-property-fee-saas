Page({
  data: {
    communityName: "云璟公馆",
    currentHouse: "8 栋 1 单元 2602",
    userName: "林悦",
    avatarText: "悦",
    totalAmount: "2486.80",
    quickActions: [
      { title: "账单明细", desc: "3 项待确认", icon: "账", active: true },
      { title: "电子收据", desc: "一键下载", icon: "票" },
      { title: "我的房屋", desc: "2 套已绑定", icon: "房" }
    ],
    bills: [
      { title: "物业管理费", desc: "2026.07 · 建面 128㎡", amount: "1920.00", icon: "物", theme: "sapphire" },
      { title: "车位管理费", desc: "B2-118 固定车位", amount: "360.00", icon: "车", theme: "emerald" },
      { title: "公共能耗分摊", desc: "电梯 / 水泵 / 照明", amount: "206.80", icon: "公", theme: "amber" }
    ]
  },
  handleQuickTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (index === 0) {
      this.goBill();
      return;
    }
    if (index === 2) {
      this.goMine();
    }
  },
  goPay() {
    wx.navigateTo({ url: "/pages/pay-confirm/pay-confirm" });
  },
  goBill() {
    wx.switchTab({ url: "/pages/bill/bill" });
  },
  goMine() {
    wx.switchTab({ url: "/pages/mine/mine" });
  }
});
