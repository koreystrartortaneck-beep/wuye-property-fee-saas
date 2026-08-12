const { adminRequest } = require('../../../utils/admin');

/*
 * 绑定申请审批。列表只显示 PENDING —— 这一页是干活的,不是查历史的。
 * 通过 = 那个人立即看得到这户账单,且其手机号自动进该房授权名单(服务端联动)。
 */

Page({
  data: {
    loading: true,
    items: [],
    /** 处理中的申请 id:双击防重 + 行内按钮转圈 */
    busy: '',
  },


  /* 下拉刷新:物业的肌肉记忆。管理端原来 13 页全没有,刷新只能杀掉重进 */
  async onPullDownRefresh() {
    try {
      await this.load();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  onShow() {
    void this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const d = await adminRequest('/admin/bindings?status=PENDING&page=1&pageSize=50', { silent: true });
      this.setData({
        items: (d.list || []).map((b) => ({
          id: b.id,
          houseName: (b.house && b.house.displayName) || '',
          houseCode: (b.house && b.house.code) || '',
          applicant: b.applicantName || '',
          phone: (b.wxUser && b.wxUser.phone) || '',
          relation: { OWNER: '业主', FAMILY: '家属', TENANT: '租客' }[b.relation] || b.relation,
        })),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async approve(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.busy) return;
    this.setData({ busy: id });
    try {
      await adminRequest(`/admin/bindings/${id}/review`, { method: 'POST', data: { approve: true } });
      wx.showToast({ title: '已通过,对方即刻可见账单', icon: 'none' });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },

  async reject(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.busy) return;
    /*
     * 驳回必须给原因 —— 业主端会显示这句话,他要照着改重新申请。
     * 手机上打字麻烦,给三个常用原因 + 自定义。
     */
    const REASONS = ['与登记业主姓名不符', '房号选择有误', '请联系物业核实身份'];
    const choice = await new Promise((resolve) =>
      wx.showActionSheet({
        itemList: REASONS,
        success: (r) => resolve(REASONS[r.tapIndex]),
        fail: () => resolve(null),
      }),
    );
    if (!choice) return;
    this.setData({ busy: id });
    try {
      await adminRequest(`/admin/bindings/${id}/review`, {
        method: 'POST',
        data: { approve: false, rejectReason: choice },
      });
      wx.showToast({ title: '已驳回', icon: 'none' });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
});
