Page({
  data: {
    amount: "2486.80",
    orderNo: "WY202607030001",
    payTime: "2026-07-03 09:59",
    house: "8 栋 1 单元 2602"
  },
  backHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },
  viewBill() {
    wx.switchTab({ url: "/pages/bill/bill" });
  }
});
