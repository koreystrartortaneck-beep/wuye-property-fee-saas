Page({
  data: {
    house: "8 栋 1 单元 2602",
    totalAmount: "2486.80",
    items: [
      { name: "物业管理费", amount: "1920.00" },
      { name: "车位管理费", amount: "360.00" },
      { name: "公共能耗分摊", amount: "206.80" }
    ]
  },
  submitPay() {
    wx.showLoading({ title: "支付中" });
    setTimeout(() => {
      wx.hideLoading();
      wx.navigateTo({ url: "/pages/pay-success/pay-success" });
    }, 700);
  }
});
