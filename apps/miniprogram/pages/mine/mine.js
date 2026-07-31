const { request } = require('../../utils/request');
const { loadMyHouses } = require('../../utils/auth');
const { requestSubscribe, getSubscribeState } = require('../../utils/subscribe');
const { BINDING_RELATION } = require('../../utils/labels');

// 与 utils/labels.js 的 BINDING_RELATION 完全重复，收敛到真源
const RELATION_LABEL = BINDING_RELATION;

Page({
  data: {
    nav: { spacerPx: 48, rowPx: 32 },
    /** 订阅授权状态：accept/reject/ban/unknown，决定「缴费提醒」的说明与点击行为 */
    notifyState: 'unknown',
    userName: '业主',
    phone: '',
    avatarText: '宅',
    currentHouse: null, // {communityName, displayName, tag}
    houseCount: 0,
    pendingBindings: [],
    deleting: false,
    menus: [
      { key: 'tickets', title: '我的工单', desc: '报修与投诉建议进度' },
      { key: 'orders', title: '我的预约', desc: '生活服务预约记录' },
      { key: 'payments', title: '缴费记录', desc: '查看历史付款凭证' },
      // 以下三页此前已开发完成并在 app.json 注册，但全站没有任何入口，
      // 属"死页面"——功能可用却无人能进。补上入口。
      { key: 'announcements', title: '社区公告', desc: '物业通知与公示' },
      { key: 'coupons', title: '我的卡券', desc: '物业发放的抵扣与服务券' },
      { key: 'workwall', title: '物业公示', desc: '保洁巡检等日常工作留痕' },
      /*
       * 缴费提醒授权入口。
       *
       * 订阅消息是一次性的：用户每授权一次才能收到一条。此前全站只有「支付确认页」
       * 一处请求授权，于是从没缴过费的业主永远没有额度、永远收不到出账与催缴通知
       * ——而最需要催缴的恰恰是这批人。这里给一个主动开启的入口。
       */
      { key: 'notify', title: '缴费提醒', desc: '开启后账单生成与到期前微信提醒你' },  // desc 会在 refreshNotifyState 里按真实状态改写
    ],
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
  },

  async onShow() {
    // 放在 onShow：业主去微信「设置 → 订阅消息」改完再回来，这里要能刷新
    void this.refreshNotifyState();
    const app = getApp();
    await app.loginReady;
    try {
      const [me, houses, bindings] = await Promise.all([
        request('/auth/me'),
        loadMyHouses(),
        request('/owner/my/bindings'),
      ]);
      const current = app.globalData.currentHouse;
      const pendingBindings = bindings
        .filter((b) => b.status !== 'ACTIVE')
        .map((b) => ({
          id: b.id,
          communityName: b.communityName,
          displayName: b.displayName,
          statusLabel: b.status === 'PENDING' ? '审核中' : '已驳回',
          rejected: b.status === 'REJECTED',
          rejectReason: b.rejectReason || '',
        }));
      this.setData({
        pendingBindings,
        phone: me.phone ? me.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '未绑定手机号',
        userName: current ? `${current.communityName}业主` : houses.length > 0 ? `${houses[0].communityName}业主` : '业主',
        houseCount: houses.length,
        currentHouse: current
          ? {
              communityName: current.communityName,
              displayName: current.displayName,
              tag: RELATION_LABEL[current.relation] || current.relation,
            }
          : null,
      });
    } catch (e) {
      console.error(e);
    }
  },

  /** 点当前房屋卡：弹出切换菜单（末项为绑定新房屋） */
  switchHouse() {
    const app = getApp();
    const houses = app.globalData.houses || [];
    // 微信 ActionSheet 上限 6 项。此前先拼满再 slice(0,6)，导致：
    // ① 房屋 ≥6 套时「＋绑定新房屋」被截掉；
    // ② tapIndex 与 items.length-1 比较错位，第 6 套房永远切不到。
    // 现改为：预留最后一格给「绑定新房屋」，房屋最多展示 5 套，
    // 超出时提供「查看全部房屋」入口。
    const MAX = 6;
    const shown = houses.slice(0, MAX - 1);
    const itemList = shown.map((h) => `${h.communityName} ${h.displayName}`);
    const hasMore = houses.length > shown.length;
    itemList.push(hasMore ? '查看全部房屋…' : '＋ 绑定新房屋');
    wx.showActionSheet({
      itemList,
      success: (res) => {
        if (res.tapIndex === itemList.length - 1) {
          if (hasMore) {
            wx.navigateTo({ url: '/pages/bind-house/bind-house' });
          } else {
            this.goBind();
          }
          return;
        }
        const target = shown[res.tapIndex];
        if (!target) return;
        app.globalData.currentHouse = target;
        this.setData({
          currentHouse: {
            communityName: target.communityName,
            displayName: target.displayName,
            tag: RELATION_LABEL[target.relation] || target.relation,
          },
        });
        wx.showToast({ title: '已切换当前房屋', icon: 'success' });
      },
    });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

  onMenuTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'tickets') wx.navigateTo({ url: '/pages/tickets/tickets' });
    if (key === 'orders') wx.navigateTo({ url: '/pages/services/services?tab=1' });
    if (key === 'payments') wx.navigateTo({ url: '/pages/payments/payments' });
    if (key === 'announcements') wx.navigateTo({ url: '/pages/announcements/announcements' });
    if (key === 'coupons') wx.navigateTo({ url: '/pages/coupons/coupons' });
    if (key === 'workwall') wx.navigateTo({ url: '/pages/work-wall/work-wall' });
    if (key === 'notify') this.enableNotify();
  },

  /**
   * 请求订阅授权。
   * 必须在用户点击的手势上下文中同步调用 wx.requestSubscribeMessage，
   * 所以这里不 await 任何网络请求再调，直接走 requestSubscribe。
   */
  /**
   * 按真实授权状态改写菜单说明。
   *
   * 微信的一次性订阅：业主授权一次只能收一条（物业类目拿不到长期订阅）。
   * 如果业主勾过「总是保持以上选择，不再询问」，状态就是 accept，后续调用会静默
   * 通过、额度持续累积——这时该告诉他「已开启」，而不是让他反复点。
   * 若是 ban（在设置里关了总开关），点按钮也没用，必须引导去右上角设置。
   */
  async refreshNotifyState() {
    const state = await getSubscribeState();
    const desc = {
      accept: '已开启，账单生成与到期前会微信提醒你',
      reject: '你之前拒绝过，点此重新开启',
      ban: '已在微信设置里关闭，需从右上角 ··· → 设置 → 订阅消息 开启',
      unknown: '开启后账单生成与到期前微信提醒你',
    }[state] || '开启后账单生成与到期前微信提醒你';
    const menus = this.data.menus.map((m) => (m.key === 'notify' ? { ...m, desc } : m));
    this.setData({ menus, notifyState: state });
  },

  async enableNotify() {
    // ban = 微信设置里关了总开关，再弹也弹不出来，直接给正确路径
    if (this.data.notifyState === 'ban') {
      wx.showModal({
        title: '需在微信设置里开启',
        content: '你在微信里关闭了本小程序的订阅消息总开关。请点右上角 ··· → 设置 → 订阅消息，把「缴费业务通知」打开。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    const accepted = await requestSubscribe();
    await this.refreshNotifyState();
    if (accepted) {
      wx.showToast({ title: '已开启缴费提醒', icon: 'success' });
      return;
    }
    wx.showModal({
      title: '未开启提醒',
      content: '没有拿到微信通知授权。可在「右上角 ··· → 设置 → 订阅消息」中开启，或稍后再点一次。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  /**
   * 注销账号。小程序上架要求必须提供该入口。
   * 后端行为：解除全部绑定 + 匿名化个人信息 + 吊销令牌，
   * 但保留财务与审计留痕（已缴费记录不会消失，符合会计要求）。
   */
  async confirmDeleteAccount() {
    if (this.data.deleting) return;

    // 先提示未缴清账单，避免业主以为注销就不用交了
    let unpaidHint = '';
    try {
      const house = getApp().globalData.currentHouse;
      if (house) {
        const sum = await request(`/owner/bills/summary?houseId=${house.houseId}`, { silent: true });
        if (Number(sum.unpaidTotal) > 0) {
          unpaidHint = `\n\n注意：名下仍有 ${sum.unpaidCount} 笔待缴费用（¥${sum.unpaidTotal}），注销不会免除欠费。`;
        }
      }
    } catch (e) {
      /* 查询失败不阻断注销 */
    }

    const first = await new Promise((resolve) =>
      wx.showModal({
        title: '注销账号',
        content:
          '注销后将解除你名下全部房屋绑定，并清除昵称、手机号等个人信息，且无法恢复。' +
          '已产生的缴费记录会按法规保留。' +
          unpaidHint,
        confirmText: '继续注销',
        confirmColor: '#c45656',
        cancelText: '取消',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!first) return;

    // 二次确认：不可恢复的操作值得再拦一次
    const second = await new Promise((resolve) =>
      wx.showModal({
        title: '再次确认',
        content: '确定要永久注销该账号吗？此操作无法撤销。',
        confirmText: '确认注销',
        confirmColor: '#c45656',
        cancelText: '我再想想',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }),
    );
    if (!second) return;

    this.setData({ deleting: true });
    wx.showLoading({ title: '正在注销' });
    try {
      await request('/owner/account', { method: 'DELETE' });
      wx.hideLoading();
      const app = getApp();
      app.globalData.houses = [];
      app.globalData.currentHouse = null;
      app.globalData.token = '';
      try {
        wx.removeStorageSync('token');
        wx.removeStorageSync('mockOpenid');
      } catch (e) {
        /* 忽略 */
      }
      await new Promise((resolve) =>
        wx.showModal({
          title: '已注销',
          content: '你的账号已注销。如需继续使用，可重新授权登录并绑定房屋。',
          showCancel: false,
          complete: resolve,
        }),
      );
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (e) {
      wx.hideLoading();
      // 错误已由 request 统一提示
    } finally {
      this.setData({ deleting: false });
    }
  },
});
