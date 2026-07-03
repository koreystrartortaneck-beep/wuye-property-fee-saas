Page({
  data: {
    tabs: ["全部", "待缴", "已缴"],
    activeTab: 1,
    totalAmount: "2486.80",
    bills: [
      { title: "物业管理费", period: "2026 年 7 月", amount: "1920.00", status: "待缴", theme: "sapphire" },
      { title: "车位管理费", period: "B2-118 固定车位", amount: "360.00", status: "待缴", theme: "emerald" },
      { title: "公共能耗分摊", period: "电梯 / 水泵 / 照明", amount: "206.80", status: "待缴", theme: "amber" },
      { title: "物业管理费", period: "2026 年 6 月", amount: "1920.00", status: "已缴", theme: "sapphire", paid: true }
    ]
  },
  setTab(e) {
    this.setData({ activeTab: Number(e.currentTarget.dataset.index) });
  },
  goPay() {
    wx.navigateTo({ url: "/pages/pay-confirm/pay-confirm" });
  }
});
