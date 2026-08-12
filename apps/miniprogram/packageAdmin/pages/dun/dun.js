/*
 * 欠费与催缴 —— 独立页面,内容由 arrears-panel 组件提供。
 *
 * 保留这个页面是因为待办、单户出账等地方会直接跳进来;首页把同一个组件
 * 当标签用。两处共用一份实现,不存在「改一处漏一处」。
 */

Page({

  /* 下拉刷新:物业的肌肉记忆。管理端原来 13 页全没有,刷新只能杀掉重进 */
  async onPullDownRefresh() {
    try {
      const p = this.selectComponent('#panel');
    if (p) await p.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  onShow() {
    // 从别处返回(比如刚登记完收款)要重新拉一次,数字才是新的
    const panel = this.selectComponent('#panel');
    if (panel) void panel.load();
  },
});
