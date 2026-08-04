const config = require('../../config');
const { request } = require('../../utils/request');
const { bindPhone, loadMyHouses } = require('../../utils/auth');
const { requestSubscribe, getSubscribeState } = require('../../utils/subscribe');
const { BINDING_RELATION, ADMIN_ROLE, label } = require('../../utils/labels');
const { BUILD } = require('../../utils/version');
const { exchangeAdmin } = require('../../utils/admin');

// 与 utils/labels.js 的 BINDING_RELATION 完全重复，收敛到真源
const RELATION_LABEL = BINDING_RELATION;

Page({
  data: {
    /*
     * 代码指纹。回答「我看到的是不是最新代码」——改完点了编译，
     * 这个值变了才说明真的生效了。与 node tools/stamp-miniprogram.mjs --print 对账。
     */
    build: BUILD,
    /*
     * 物业工作人员标识。认证 = 微信授权手机号匹配管理员名单(服务端换发令牌),
     * 静默探测:是管理员就多出「物业管理」入口,普通业主什么都看不到。
     * 界面显隐只是引导 —— 真正的门在服务端(AdminGuard),入口被转发也进不去。
     */
    adminName: '',
    adminRoleText: '',
    loadError: false, // 档案加载失败：与「真的没绑房屋」区分开
    nav: { spacerPx: 48, rowPx: 32 },
    /** 订阅授权状态：accept/reject/ban/unknown，决定「缴费提醒」的说明与点击行为 */
    notifyState: 'unknown',
    userName: '业主',
    phone: '',
    /*
     * 手机号是**可选**的：身份由微信 openid 决定，权限由房屋绑定决定，
     * 手机号只用来自动匹配房屋、以及让物业能联系到你。
     * 所以未绑定时不能摆一句「未绑定手机号」就完事 —— 那看起来像个待办，
     * 却既没解释也没出口（这一行原来是个不可点的 view，
     * 而唯一的绑定入口在「绑定房屋」页，已经绑好房屋的人不会再进去）。
     */
    hasPhone: false,
    mockAuth: config.mockAuth,
    avatarText: '宅',
    currentHouse: null, // {communityName, displayName, tag}
    houseCount: 0,
    pendingBindings: [],
    /** 有在途绑定申请：决定「我的房屋」卡显示「审核中」还是「去绑定」 */
    hasPendingApply: false,
    deleting: false,
    /*
     * 「我的」只放**跟我有关**的：我的工单、我的预约、我的缴费、我的卡券、我的提醒。
     *
     * 社区公告与物业公示是全小区内容，不是「我的」——业主指出后移除。
     * 它们由首页「社区动态 → 查看全部」进统一动态流（community 页，
     * 自带 全部/公告/物业公示 筛选），独立的 announcements / work-wall
     * 两个页面与之完全重复，已随本次一并删除。
     * （这两项当初被塞进来，是因为那两个页面曾是全站无入口的死页面 ——
     * 正确解法是删掉重复页面，而不是给它们造入口。）
     */
    menus: [
      { key: 'tickets', title: '我的工单', desc: '报修与投诉建议进度' },
      { key: 'orders', title: '我的预约', desc: '生活服务预约记录' },
      { key: 'payments', title: '缴费记录', desc: '查看历史付款凭证' },
      { key: 'coupons', title: '我的卡券', desc: '物业发放的抵扣与服务券' },
      /*
       * 缴费提醒授权入口。
       *
       * 订阅消息是一次性的：用户每授权一次才能收到一条。此前全站只有「支付确认页」
       * 一处请求授权，于是从没缴过费的业主永远没有额度、永远收不到出账与催缴通知
       * ——而最需要催缴的恰恰是这批人。这里给一个主动开启的入口。
       */
      { key: 'notify', title: '缴费提醒', desc: '开启后账单生成与到期前微信提醒您' },  // desc 会在 refreshNotifyState 里按真实状态改写
    ],
  },

  onLoad() {
    this.setData({ nav: getApp().globalData.nav });
  },

  async onShow() {
    // 静默探测管理员身份,不阻塞页面其余加载
    exchangeAdmin().then((admin) =>
      this.setData({
        adminName: admin ? admin.name : '',
        // 显示角色,不显示账号名:生产上那个账号就叫 admin
        adminRoleText: admin ? label(ADMIN_ROLE, admin.role, '物业工作人员') : '',
      }),
    );
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
      /*
       * 只显示「需要业主关心的那一条」，不是把所有历史都摊开。
       *
       * 2026-08-02 实测：业主的「我的」页上并排摆着
       *   ● 金港城 1 栋 1 单元 101 · 已解除（手机号变更，自动…
       *   ● 金港城 1栋1单元101 · 审核中
       * 两条看起来一模一样，而上面那条是废弃租户的历史 —— 他完全分不清，
       * 也不知道该点哪个「重新申请」。
       *
       * 规则：**只要有在途申请（PENDING），就不显示任何已结束的记录**。
       * 他已经在走流程了，上一轮的结论跟他没关系。
       * 没有在途申请时，才显示最近一条被驳回/解除的，让他知道为什么、能重新来。
       */
      const notActive = bindings.filter((b) => b.status !== 'ACTIVE');
      const pending = notActive.filter((b) => b.status === 'PENDING');
      const finished = notActive.filter((b) => b.status === 'REJECTED');
      const pendingBindings = (pending.length > 0 ? pending : finished.slice(0, 1))
        .map((b) => ({
          id: b.id,
          communityName: b.communityName,
          displayName: b.displayName,
          /*
           * 「申请被驳回」和「已生效的绑定被物业解除」在库里都是 REJECTED，
           * 但对业主是完全不同的事。首页已经分开说了，这里不能还叫「已驳回」——
           * 同一件事在两个页面两种说法，比说错更让人糊涂。
           */
          statusLabel: b.status === 'PENDING' ? '审核中' : b.revokedAt ? '已解除' : '已驳回',
          rejected: b.status === 'REJECTED',
          rejectReason: (b.revokedAt ? b.revokeReason : b.rejectReason) || '',
        }));
      this.setData({
        pendingBindings,
        // 有在途申请时，「我的房屋」那张卡不能再叫人「去绑定」
        hasPendingApply: pending.length > 0,
        phone: me.phone ? me.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '未绑定手机号',
        hasPhone: !!me.phone,
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
      /*
       * 原先只 console.error，于是 currentHouse 保持 null，界面显示
       * 「尚未绑定房屋」——业主已经绑好了，看到这句会以为绑定掉了，进而重复提交
       * 实名申请。加载失败与真的没绑必须区分。
       */
      console.error(e);
      this.setData({ loadError: true });
    }
  },

  retryProfile() {
    this.setData({ loadError: false });
    this.onShow();
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
    if (key === 'coupons') wx.navigateTo({ url: '/pages/coupons/coupons' });
    if (key === 'notify') this.enableNotify();
  },

  /**
   * 请求订阅授权。
   * 必须在用户点击的手势上下文中同步调用 wx.requestSubscribeMessage，
   * 所以这里不 await 任何网络请求再调，直接走 requestSubscribe。
   */
  /**
   * 微信手机号授权回调（真机路径）。
   *
   * 必须由 <button open-type="getPhoneNumber"> 触发 —— 普通 bindtap 拿不到 code，
   * 这也是为什么未绑定时那一行要渲染成 button 而不是 view。
   */
  async onGetPhone(e) {
    const code = e.detail && e.detail.code;
    if (!code) {
      // 用户点了取消。不报错，但要说清放弃的是什么
      wx.showToast({ title: '未授权，物业将无法电话联系您', icon: 'none', duration: 2500 });
      return;
    }
    wx.showLoading({ title: '绑定中' });
    try {
      const res = await bindPhone(code);
      await loadMyHouses();
      wx.hideLoading();
      // 顺带匹配到房屋是意外之喜，要说出来；没匹配到也不是失败
      wx.showToast({
        title: res.matchedHouses > 0 ? `已绑定，并自动匹配 ${res.matchedHouses} 处房屋` : '手机号已绑定',
        icon: 'none',
        duration: 2200,
      });
      // 本页的加载逻辑在 onShow 里（没有单独的 load 方法），直接重跑一次
      await this.onShow();
    } catch (err) {
      wx.hideLoading();
    }
  },

  /** mock 模式（开发用）没有微信授权按钮，引导到绑定房屋页手动输入 */
  goAdmin() {
    wx.navigateTo({ url: '/packageAdmin/pages/home/home' });
  },

  goBindPhone() {
    if (this.data.hasPhone) return;
    wx.navigateTo({ url: '/pages/bind-house/bind-house' });
  },

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
      accept: '已开启，账单生成与到期前会微信提醒您',
      reject: '您之前拒绝过，点此重新开启',
      ban: '已在微信设置里关闭，需从右上角 ··· → 设置 → 订阅消息 开启',
      unknown: '开启后账单生成与到期前微信提醒您',
    }[state] || '开启后账单生成与到期前微信提醒您';
    const menus = this.data.menus.map((m) => (m.key === 'notify' ? { ...m, desc } : m));
    this.setData({ menus, notifyState: state });
  },

  async enableNotify() {
    // ban = 微信设置里关了总开关，再弹也弹不出来，直接给正确路径
    if (this.data.notifyState === 'ban') {
      wx.showModal({
        title: '需在微信设置里开启',
        content: '您在微信里关闭了本小程序的订阅消息总开关。请点右上角 ··· → 设置 → 订阅消息，把「缴费业务通知」打开。',
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

    /*
     * 先提示未缴清账单，避免业主以为注销就不用交了。
     *
     * 两处修正（2026-08-01 全量排查发现）：
     *
     * ① 原来只查 globalData.currentHouse ——「当前选中的那一户」。
     *    绑了两户的业主，若欠费在另一户，注销时**完全看不到警告**，
     *    而这个警告存在的全部意义就是防这件事。
     *    /owner/bills/summary 不传 houseId 时汇总名下全部房屋，所以直接不传。
     *
     * ② 查询失败时原来静默略过。而「没有警告」在业主眼里等于「我不欠钱」——
     *    这是一次静默的误导。现在如实说没能确认，让他自己去核对。
     */
    let unpaidHint = '';
    try {
      const sum = await request('/owner/bills/summary', { silent: true });
      if (Number(sum.unpaidTotal) > 0) {
        unpaidHint = `\n\n注意：名下仍有 ${sum.unpaidCount} 笔待缴费用（¥${sum.unpaidTotal}），注销不会免除欠费。`;
      }
    } catch (e) {
      unpaidHint = '\n\n提示：未能确认您名下是否还有待缴费用，请先自行核对；注销不会免除欠费。';
    }

    const first = await new Promise((resolve) =>
      wx.showModal({
        title: '注销账号',
        content:
          /*
           * 文案必须与后端实际清除的范围一致，否则本身就是一个合规问题。
           * 后端 owner-account.service 现在清的是：昵称/手机号/openid、
           * 绑定申请人姓名、上门服务联系人、访客姓名手机号车牌、报修照片；
           * 报修文字与缴费凭证保留（凭证里的付款人姓名改存「张*」）。
           */
          '注销后将解除您名下全部房屋绑定，并清除昵称、手机号、姓名、访客与上门服务的联系信息、' +
          '报修照片，且无法恢复。' +
          '已产生的缴费与开票凭证会按法规保留，其中付款人姓名会脱敏保存（如「张*」）。' +
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
          content: '您的账号已注销。如需继续使用，可重新授权登录并绑定房屋。',
          showCancel: false,
          complete: resolve,
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
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
