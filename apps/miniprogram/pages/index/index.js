const { request } = require('../../utils/request');
const { imageUrl } = require('../../utils/upload');
const { loadMyHouses } = require('../../utils/auth');
const { WORK_CATEGORY } = require('../../utils/labels');

// 分类文案的单一真源在 utils/labels.js。原先 4 个页面各写一份且互相矛盾：
// OTHER 一半是「公示」一半是「其他」，INSPECTION 一半是「巡检」一半是「日常巡检」，
// 业主在列表看到「巡检」点进详情会变成「日常巡检」。
const WORK_CAT = WORK_CATEGORY;

/** 公告 + 物业公示 混排成一条社区动态流（公告置顶优先，其余按时间倒序） */
function buildFeed(anns, works) {
  const annItems = (anns || []).map((a) => ({
    type: 'ann',
    id: a.id,
    title: a.title,
    preview: (a.content || '').replace(/\n+/g, ' ').slice(0, 56),
    pinned: a.pinned,
    date: (a.publishedAt || '').slice(5, 10).replace('-', '/'),
    ts: Date.parse(a.publishedAt) || 0,
  }));
  const workItems = (works || [])
    .filter((w) => (w.images || []).length > 0)
    .map((w) => ({
      type: 'work',
      id: w.id,
      title: w.title || WORK_CAT[w.category] || '物业公示',
      preview: w.description || '',
      tag: WORK_CAT[w.category] || '公示',
      cover: imageUrl(w.images[0]),
      count: (w.images || []).length,
      date: (w.createdAt || '').slice(5, 10).replace('-', '/'),
      ts: Date.parse(w.createdAt) || 0,
    }));
  const pinned = annItems.filter((a) => a.pinned).sort((x, y) => y.ts - x.ts);
  const rest = annItems.filter((a) => !a.pinned).concat(workItems).sort((x, y) => y.ts - x.ts);
  return pinned.concat(rest);
}

Page({
  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    ready: false,
    /*
     * 加载失败必须有独立状态。原先 onShow 的 catch 只 console.error，然后 finally
     * 把 ready 置 true，于是界面拿 data 的初值渲染：「待缴合计（0 笔）/ ¥ 0.00 /
     * 立即缴纳」——业主据此以为自己没有欠费。房屋切换时更确定，因为 houseChanged
     * 分支会先把金额清成 '0.00' 再去请求。
     */
    error: false,
    noHouse: false,
    /** 无生效房屋时的申请状态：null=从没申请过 / {rejected,house,reason} */
    pendingBinding: null,
    currentHouse: null,
    houses: [],
    unpaidTotal: '0.00',
    unpaidCount: 0,
    paidUp: false, // 本期已缴清
    collectionPaused: false, // 物业是否暂停线上收款（由后端分层策略派生）
    pausedReason: '',
    feed: [], // 社区动态：公告 + 物业公示混排
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
  },

  async onShow() {
    const app = getApp();
    await app.loginReady;
    this.setData({ error: false });
    try {
      const houses = await loadMyHouses();
      if (houses.length === 0) {
        /*
         * 没有生效的房屋，不代表「什么都没做过」。
         *
         * myHouses 只返回 ACTIVE 绑定，所以提交了申请、正在等审核的业主
         * 落到的是同一个分支 —— 首页原来对他说「首次使用请先绑定您的房屋」，
         * 并给一个「立即绑定」按钮。他看不到任何申请痕迹，会合理地以为申请丢了，
         * 于是再申请一次，然后撞上后端的唯一约束报「已存在绑定」。
         * 而审核通过也没有任何通知（通知只有出账/到期/逾期三种），
         * 他只能反复打开小程序碰运气 —— 申请之后就进了黑洞。
         *
         * 所以这里要把「从没申请过」「审核中」「被驳回」分开。
         * 驳回尤其要说明原因，否则业主既不知道为什么，也不知道能不能再来一次。
         */
        let pending = null;
        try {
          const bindings = await request('/owner/my/bindings', { silent: true });
          const latest = (bindings || []).find((b) => b.status === 'PENDING')
            || (bindings || []).find((b) => b.status === 'REJECTED');
          if (latest) {
            pending = {
              rejected: latest.status === 'REJECTED',
              house: `${latest.communityName} ${latest.displayName}`,
              reason: latest.rejectReason || '',
            };
          }
        } catch (e) {
          // 读不到申请状态时退回原来的引导，总比什么都不显示强
        }
        this.setData({
          ready: true, noHouse: true, pendingBinding: pending,
          unpaidTotal: '0.00', unpaidCount: 0, feed: [],
        });
        return;
      }
      const nextHouse = app.globalData.currentHouse;
      // 房屋变了：先清掉上一个房屋的内容，杜绝"新房屋标题 + 旧房屋数据"同框
      const houseChanged = !this.data.currentHouse || this.data.currentHouse.houseId !== nextHouse.houseId;
      this.setData({
        noHouse: false,
        houses,
        currentHouse: nextHouse,
        ...(houseChanged ? { feed: [], unpaidTotal: '0.00', unpaidCount: 0, paidUp: false } : {}),
      });
      await this.loadHome();
    } catch (e) {
      console.error(e);
      // 不确定金额时不要显示金额：宁可让业主看到「没能加载」也不能让他以为已缴清
      this.setData({ error: true, unpaidTotal: '', unpaidCount: 0, paidUp: false, feed: [] });
    } finally {
      this.setData({ ready: true });
    }
  },

  retry() {
    this.onShow();
  },

  /*
   * 请求令牌：快速切换房屋时，先发的请求可能后到，把 A 房屋的金额写到 B 房屋的
   * 标题下面。bill.js 早就有这个保护，首页漏了——而首页恰好是金额最显眼的地方。
   */
  _reqToken: 0,

  async loadHome() {
    const house = getApp().globalData.currentHouse;
    if (!house) return;
    this._reqToken += 1;
    const myToken = this._reqToken;
    const [summary, billPage, anns, works] = await Promise.all([
      request(`/owner/bills/summary?houseId=${house.houseId}`),
      // 未缴账单不再在首页展示，只为「立即缴纳」合并下单做准备
      request(`/owner/bills?houseId=${house.houseId}&status=UNPAID&pageSize=50`),
      request(`/owner/announcements?houseId=${house.houseId}`).catch(() => []),
      request(`/owner/work-logs?houseId=${house.houseId}&pageSize=8`).catch(() => ({ list: [] })),
    ]);
    // 期间又切了房屋：这批数据已经过期，丢弃
    if (myToken !== this._reqToken) return;
    this._unpaidBills = billPage.list.map((b) => ({
      id: b.id,
      name: b.title,
      amount: Number(b.amount).toFixed(2),
    }));
    this.setData({
      currentHouse: house,
      unpaidTotal: summary.unpaidTotal,
      unpaidCount: summary.unpaidCount,
      paidUp: summary.unpaidCount === 0,
      feed: buildFeed(anns, works.list).slice(0, 3),
    });
    // 有待缴账单时，向后端复核分层收款状态，暂停则给出提示（收款状态完全由后端派生）
    await this.refreshCollectionState();
  },

  /** 借用首张待缴账单的报价复核该小区收款是否暂停，不新增专用接口。 */
  async refreshCollectionState() {
    const first = (this._unpaidBills || [])[0];
    if (!first) {
      this.setData({ collectionPaused: false, pausedReason: '' });
      return;
    }
    try {
      const quote = await request(`/owner/payments/quote/${first.id}`, { silent: true });
      const paused = !!(quote.collection && quote.collection.status === 'PAUSED');
      this.setData({
        collectionPaused: paused,
        pausedReason: (quote.collection && quote.collection.reason) || '',
      });
    } catch (e) {
      // 复核失败不影响首页展示
      this.setData({ collectionPaused: false, pausedReason: '' });
    }
  },

  async onPullDownRefresh() {
    try {
      await this.loadHome();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /** 多房切换 */
  switchHouse() {
    const { houses } = this.data;
    if (houses.length <= 1) return;
    wx.showActionSheet({
      itemList: houses.map((h) => `${h.communityName} ${h.displayName}`),
      success: async (res) => {
        const target = houses[res.tapIndex];
        getApp().globalData.currentHouse = target;
        // 先清旧数据再加载，避免切换瞬间的脏渲染
        this.setData({
          currentHouse: target,
          annList: [],
          unpaidTotal: '0.00',
          unpaidCount: 0,
          paidUp: false,
        });
        await this.loadHome();
      },
    });
  },

  /** 社区动态「查看全部」→ 统一动态流页 */
  goFeed() {
    wx.navigateTo({ url: '/pages/community/community' });
  },

  /** 点击一条动态：按类型进对应详情 */
  goFeedItem(e) {
    const { id, type } = e.currentTarget.dataset;
    if (type === 'work') wx.navigateTo({ url: `/pages/work-detail/work-detail?id=${id}` });
    else wx.navigateTo({ url: `/pages/announcement-detail/announcement-detail?id=${id}` });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  goBill() {
    wx.switchTab({ url: '/pages/bill/bill' });
  },

  /** 英雄卡主按钮：单账单单支付，统一进入账单列表逐张缴费 */
  heroAction() {
    // 这里曾顺带请求订阅授权。已删——这只是一次跳转，不该弹权限框。
    this.goBill();
  },
});
