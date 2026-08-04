const { adminRequest } = require('../../../utils/admin');
// 枚举文案一律取自 utils/labels(与后端枚举有守卫逐项比对),页面不自建映射
const { BILL_STATUS, label, periodLabel } = require('../../../utils/labels');
const { createPoller } = require('../../../utils/poller');

/*
 * 房屋详情 —— 管理端的核心一屏:这套房的一切,以及现场要做的动作。
 *
 * 实测反馈:「我选中某一个,点进去之后应该是只给这一户编辑+发账单,现在非常混乱」。
 * 所以这一页是**单户作业台**,进来之后所有动作都只作用于这一户:
 *   欠多少(大字)→ 房屋信息(面积/放户日期,可改)→ 收费标准(挂哪条,可换)
 *   → 谁能看到账单(手机号,可换)→ 账单历史 → 给这一户出账单
 *
 * 「范围」这件事在这一页不存在:不给选楼栋、不给选全部。
 * 批量出账在首页底部的「发账单」,两条路各自笔直。
 */

const MONTH = ['', '1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];

/** 标准的计价口径,给人看的一句话 */
function priceText(rule) {
  const p = rule.params || {};
  if (rule.ruleType === 'AREA_PRICE') return `${p.unitPrice} 元/㎡/月`;
  if (rule.ruleType === 'FIXED') return `固定 ${p.amount} 元`;
  if (rule.ruleType === 'METER') return `按抄表 ${p.unitPrice} 元/单位`;
  return '按公摊';
}

Page({
  data: {
    id: '',
    /** 当前板块:bills / contacts / standards / info —— 一屏一件事,不用上下滑 */
    tab: 'bills',
    loading: true,
    loadError: false,
    house: null,
    summary: null,
    bills: [],
    payments: [],
    /** 退款在途的笔数:汇总里待缴/已缴都不含它,不单独说就看不见 */
    refunding: 0,
    contacts: [],
    /** 收费标准挂接 */
    standards: [],
    rules: [],
    pickingRule: false,
    /** 每年出账月份的人话 */
    billMonthText: '',
    /** 编辑房屋信息 */
    editing: false,
    form: { displayName: '', area: '', handoverDate: '', status: 'ACTIVE' },
    saving: false,
    /** 加号表单 */
    newPhone: '',
    newName: '',
    adding: false,
    deleting: false,
  },

  onLoad(query) {
    this.setData({ id: query.id });
    /*
     * 退款/支付的最终状态由微信回调或查单裁决,几秒到两分钟才落地。
     * 不自动刷新的话,人看到的是「退款中」而库里早已 REFUNDED(实测踩过)。
     * onShow 救不了 —— 他根本没离开这一页。
     */
    this._poller = createPoller({
      load: () => this.load(),
      isPending: () =>
        (this.data.bills || []).some((b) => b.status === 'REFUNDING') ||
        (this.data.payments || []).some((p) => p.status === 'CREATED' || p.status === 'PREPAY_UNKNOWN'),
      onGiveUp: () =>
        wx.showToast({ title: '状态还没落地,可在电脑后台查支付溯源', icon: 'none', duration: 3000 }),
    });
  },

  onShow() {
    void this.load();
  },

  onHide() {
    this._poller.stop();
  },

  onUnload() {
    this._poller.stop();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    try {
      const [profile, contacts, standards] = await Promise.all([
        adminRequest(`/admin/house-profile/${this.data.id}`, { silent: true }),
        adminRequest(`/admin/houses/${this.data.id}/contacts`, { silent: true }),
        adminRequest(`/admin/houses/${this.data.id}/standards`, { silent: true }),
      ]);
      /*
       * 放户日期两处都能给:/standards 一直有,/house-profile 是这次新加的。
       * 优先取前者 —— 后端还没部署完时若只认 profile,页面会对着一个填好的
       * 放户日期显示「未填」。界面说谎比报错严重(这是同一个坑的第三次)。
       */
      const anchor = (standards.house && standards.house.handoverDate
        ? String(standards.house.handoverDate).slice(0, 10)
        : '') || profile.house.handoverDate || '';
      const house = { ...profile.house, handoverDate: anchor };
      /*
       * 「退款中」必须单独露出来。
       * 汇总只统计待缴与已缴(与欠费清单同口径),于是一笔退款在途时两个大字都是
       * ¥0.00 —— 页面看着像一套没有任何账的房,而下面明明列着一笔 ¥17。
       */
      const refunding = (profile.bills || []).filter((b) => b.status === 'REFUNDING');
      this.setData({
        house,
        summary: profile.summary,
        refunding: refunding.length,
        billMonthText: anchor ? `每年 ${MONTH[Number(anchor.slice(5, 7))]}出账` : '没填放户日期,出不了账',
        /*
         * 每笔账单带上它对应的支付订单号与通道 —— 这一页要能直接动钱:
         *   待缴 → 线下收款登记
         *   微信已缴 → 退款(原路退回)
         *   线下已缴 → 冲正(把这笔现金记录作废,账单回到待缴)
         * profile.payments 里有 id/orderNo/channel,账单上有 paymentId,在这里对上。
         */
        bills: (profile.bills || []).slice(0, 20).map((b) => {
          const pay = b.paymentId ? (profile.payments || []).find((p) => p.id === b.paymentId) : null;
          return {
            ...b,
            statusLabel: label(BILL_STATUS, b.status),
            periodText: periodLabel(b.period),
            orderNo: pay ? pay.orderNo : '',
            channel: pay ? pay.channel : '',
            canCollect: b.status === 'UNPAID',
            canRefund: b.status === 'PAID' && pay && pay.channel === 'WXPAY' && pay.status === 'SUCCESS',
            canReverse: b.status === 'PAID' && pay && pay.channel === 'OFFLINE' && pay.status === 'SUCCESS',
          };
        }),
        payments: profile.payments || [],
        contacts: contacts.items || [],
        standards: (standards.items || [])
          .filter((s) => s.status === 'ACTIVE')
          .map((s) => ({
            ruleId: s.ruleId,
            name: s.rule.name,
            price: priceText(s.rule),
            // 挂接自带 startDate 时,锚点是它而不是房屋的放户日期
            anchorText: s.startDate ? `账期锚点 ${String(s.startDate).slice(0, 10)}` : '',
          })),
        form: {
          displayName: house.displayName,
          area: house.area || '',
          handoverDate: house.handoverDate || '',
          status: house.status,
        },
      });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
      // 有钱在路上(退款中 / 支付未终结)就自己转起来,变完自动停
      this._poller.kick();
    }
  },

  pickTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t, editing: false });
  },

  /* ── 编辑房屋信息 ── */
  startEdit() {
    this.setData({ editing: true });
  },
  cancelEdit() {
    const h = this.data.house;
    this.setData({
      editing: false,
      form: { displayName: h.displayName, area: h.area || '', handoverDate: h.handoverDate || '', status: h.status },
    });
  },
  onFormInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value });
  },
  onHandover(e) {
    this.setData({ 'form.handoverDate': e.detail.value });
  },
  pickStatus(e) {
    this.setData({ 'form.status': e.currentTarget.dataset.v });
  },

  async saveHouse() {
    const f = this.data.form;
    const h = this.data.house;
    if (!f.displayName.trim()) return wx.showToast({ title: '房号不能为空', icon: 'none' });
    const area = String(f.area).trim();
    if (area && !(Number(area) > 0)) return wx.showToast({ title: '面积要是大于 0 的数', icon: 'none' });
    /*
     * 只发真改了的字段。全字段回写会把「没动的值」也算成一次修改,
     * 审计里堆满假变更,真正改过面积的那一次就淹了。
     */
    const patch = {};
    if (f.displayName.trim() !== h.displayName) patch.displayName = f.displayName.trim();
    if (area && area !== String(h.area || '')) patch.area = Number(area);
    if (f.handoverDate !== (h.handoverDate || '')) patch.handoverDate = f.handoverDate;
    if (f.status !== h.status) patch.status = f.status;
    if (Object.keys(patch).length === 0) {
      this.setData({ editing: false });
      return;
    }
    /*
     * 面积和放户日期直接决定账单金额与出账月份。改之前把后果说全 ——
     * 现场改数据的人未必知道「放户日期」是出账依据。
     */
    if (patch.area || patch.handoverDate) {
      const ok = await new Promise((resolve) =>
        wx.showModal({
          title: '确认修改',
          content: [
            patch.area ? `面积改为 ${patch.area} ㎡(以后出账按新面积算)` : '',
            patch.handoverDate ? `放户日期改为 ${patch.handoverDate}(以后每年在这个月出账)` : '',
            '已经出过的账单金额不变。',
          ]
            .filter(Boolean)
            .join('\n'),
          confirmText: '保存',
          success: (r) => resolve(r.confirm),
          // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
          fail: () => resolve(false),
        }),
      );
      if (!ok) return;
    }
    this.setData({ saving: true });
    try {
      await adminRequest(`/admin/houses/${this.data.id}`, { method: 'PATCH', data: patch });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ editing: false });
      await this.load();
    } finally {
      this.setData({ saving: false });
    }
  },

  /* ── 收费标准挂接 ── */
  async togglePickRule() {
    const open = !this.data.pickingRule;
    this.setData({ pickingRule: open });
    if (!open || this.data.rules.length > 0) return;
    const d = await adminRequest(
      `/admin/fee-rules?communityId=${this.data.house.communityId}&pageSize=100`,
      { silent: true },
    );
    const attached = new Set(this.data.standards.map((s) => s.ruleId));
    this.setData({
      rules: (d.list || [])
        .filter((r) => r.periodScheme === 'ANNIVERSARY' && r.enabled && !attached.has(r.id))
        .map((r) => ({ id: r.id, name: r.name, price: priceText(r) })),
    });
  },

  async attachRule(e) {
    const r = this.data.rules[e.currentTarget.dataset.i];
    await adminRequest(`/admin/houses/${this.data.id}/standards`, { method: 'POST', data: { ruleId: r.id } });
    wx.showToast({ title: '已挂上,下次出账按它算', icon: 'none', duration: 2200 });
    this.setData({ pickingRule: false, rules: [] });
    await this.load();
  },

  async detachRule(e) {
    const { id, name } = e.currentTarget.dataset;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '摘除收费标准',
        content: `摘除「${name}」后,这户以后不再按它出账(空置/免收就该摘)。已经出过的账单不动。`,
        confirmText: '摘除',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    await adminRequest(`/admin/houses/${this.data.id}/standards/${id}`, { method: 'DELETE' });
    wx.showToast({ title: '已摘除', icon: 'none' });
    this.setData({ rules: [] });
    await this.load();
  },

  /* ── 授权手机号 ── */
  onPhoneInput(e) {
    this.setData({ newPhone: e.detail.value });
  },
  onNameInput(e) {
    this.setData({ newName: e.detail.value });
  },

  async addContact() {
    const phone = this.data.newPhone.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入 11 位手机号', icon: 'none' });
      return;
    }
    if (this.data.adding) return;
    this.setData({ adding: true });
    try {
      const r = await adminRequest(`/admin/houses/${this.data.id}/contacts`, {
        method: 'POST',
        data: { phone, name: this.data.newName.trim() || undefined },
      });
      wx.showToast({
        title: r.activatedBindings > 0 ? '已添加,对方已绑定' : '已添加,对方授权后可见账单',
        icon: 'none',
        duration: 2500,
      });
      this.setData({ newPhone: '', newName: '' });
      await this.load();
    } finally {
      this.setData({ adding: false });
    }
  },

  async removeContact(e) {
    const { id, phone } = e.currentTarget.dataset;
    /*
     * 删号是权限撤销(对方立刻看不到账单),现场操作给一次确认 ——
     * 手机上误触比电脑鼠标高一个数量级,这一下不是「防护」是防手滑。
     */
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '移除授权',
        content: `移除 ${phone} 后,该手机号对应的用户将立即看不到本房账单。`,
        confirmText: '移除',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    const r = await adminRequest(`/admin/house-contacts/${id}`, { method: 'DELETE' });
    wx.showToast({
      title: r.revokedBindings.length > 0 ? `已移除,同时解除 ${r.revokedBindings.length} 人绑定` : '已移除',
      icon: 'none',
      duration: 2500,
    });
    await this.load();
  },

  /** 业主拿现金来交:去收款登记页(金额在那页现查,不带过去) */
  goCollect(e) {
    const billId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/packageAdmin/pages/collect/collect?billId=${billId}&houseId=${this.data.id}` });
  },

  /*
   * 退款:全额原路退回业主微信。
   *
   * 系统不支持部分退款(退款接口不接受金额,一律按原订单全额),所以界面
   * 也绝不能给一个金额输入框。确认框把三件事说全:退多少、退到哪、能不能撤。
   */
  async refund(e) {
    const { order, amount } = e.currentTarget.dataset;
    const reason = await askText('退款原因', '必填,记入审计,业主客服都能查');
    if (!reason) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '确认退款',
        content: `全额退 ¥${amount} 到业主的微信(原路退回,通常几分钟到账)。退款发起后不能撤销,这笔账单会变成「已退款」。`,
        confirmText: '确认退款',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    try {
      await adminRequest('/admin/refunds', {
        method: 'POST',
        data: { orderNo: order, reason, requestId: `mp-refund-${order}` },
      });
      wx.showToast({ title: '已发起退款', icon: 'success' });
      await this.load();
    } catch (err) {
      // 退款限管理员角色:403 要说清是权限问题,而不是让人反复重试
      if (err && err.code === 40300) {
        wx.showModal({ title: '权限不够', content: '退款只有物业管理员账号能做。请让管理员在手机或电脑后台操作。', showCancel: false });
      }
    }
  },

  /** 冲正:线下收款记错了。钱本来就没进系统,作废记录、账单回到待缴 */
  async reverse(e) {
    const { order, amount } = e.currentTarget.dataset;
    const reason = await askText('冲正原因', '必填,例如「收款登记错户」');
    if (!reason) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '确认冲正',
        content: `把这笔 ¥${amount} 的线下收款记录作废,账单回到「待缴」。现金本身在你手里,系统只是撤销这条记录。`,
        confirmText: '确认冲正',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    try {
      await adminRequest(`/admin/payments/${order}/reverse-offline`, {
        method: 'POST',
        data: { reason, requestId: `mp-reverse-${order}` },
      });
      wx.showToast({ title: '已冲正,账单回到待缴', icon: 'none', duration: 2500 });
      await this.load();
    } catch (err) {
      if (err && err.code === 40300) {
        wx.showModal({ title: '权限不够', content: '冲正只有物业管理员账号能做。请让管理员操作。', showCancel: false });
      }
    }
  },

  /*
   * 删除这套房。
   *
   * 先走常规删除 —— 它会把「还有账单 N 条」如实说出来。被挡住时才升级到
   * 「彻底删除」,而且要人原样打出房号:那一步会把这套房名下的账单、缴费、
   * 退款、发票全部物理销毁,不可恢复。绝不把它做成一个直接可点的按钮。
   */
  async removeHouse() {
    const h = this.data.house;
    if (!h || this.data.deleting) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: `删除 ${h.displayName}`,
        content: '删除后这套房从楼盘图里消失。出过账单的房屋删不掉,系统会告诉你原因。',
        confirmText: '删除',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;
    this.setData({ deleting: true });
    try {
      await adminRequest(`/admin/houses/${this.data.id}`, { method: 'DELETE', silent: true });
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      const msg = (err && err.message) || '';
      if (err && err.code === 40300) {
        wx.showModal({ title: '权限不够', content: '删除房屋只有物业管理员账号能做。', showCancel: false });
        return;
      }
      if (!/不能删除/.test(msg)) {
        wx.showModal({ title: '删不了', content: msg || '请稍后重试', showCancel: false });
        return;
      }
      await this.offerPurge(h, msg);
    } finally {
      this.setData({ deleting: false });
    }
  },

  /** 常规删除被历史数据挡住时的唯一出路:彻底销毁(需原样打出房号) */
  async offerPurge(house, why) {
    const go = await new Promise((resolve) =>
      wx.showModal({
        title: '删不掉',
        content: `${why}\n\n如果这是测试房,可以「彻底删除」——连它名下的账单、缴费、退款、发票一起物理销毁,不可恢复。`,
        confirmText: '彻底删除',
        cancelText: '算了',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
        // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!go) return;
    const typed = await new Promise((resolve) =>
      wx.showModal({
        title: '最后确认',
        editable: true,
        placeholderText: `请原样输入:${house.displayName}`,
        content: '',
        confirmText: '销毁',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm && r.content ? r.content.trim() : ''),
        fail: () => resolve(''),
      }),
    );
    if (typed !== house.displayName) {
      if (typed) wx.showToast({ title: '名字不一致,已取消', icon: 'none' });
      return;
    }
    const r = await adminRequest('/admin/maintenance/purge', {
      method: 'POST',
      data: { target: 'HOUSE', id: this.data.id, confirm: house.displayName },
    });
    const n = Object.values(r.deleted || {}).reduce((a, b) => a + b, 0);
    wx.showModal({
      title: '已彻底删除',
      content: `${house.displayName} 及其名下 ${n} 条数据已销毁。`,
      showCancel: false,
      success: () => wx.navigateBack(),
    });
  },

  /** 只给这一户出账单:单页面,不再回到批量流程里选范围 */
  goBillThisHouse() {
    const h = this.data.house;
    if (!h) return;
    wx.navigateTo({ url: `/packageAdmin/pages/bill-one/bill-one?id=${h.id}` });
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
});

/** 必填原因的输入框:空输入等于取消(后端也要求非空,提前挡住少一次失败请求) */
function askText(title, placeholder) {
  return new Promise((resolve) =>
    wx.showModal({
      title,
      editable: true,
      placeholderText: placeholder,
      success: (r) => resolve(r.confirm && r.content && r.content.trim() ? r.content.trim() : ''),
      fail: () => resolve(''),
    }),
  );
}
