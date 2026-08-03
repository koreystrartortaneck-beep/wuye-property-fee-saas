const { adminRequest } = require('../../../utils/admin');

/*
 * 待发布账单 —— 首页那条「本月账单已生成待发布」点进来的地方。
 *
 * 它以前弹的是「这类事项请在电脑后台处理」:待办在提醒你有事要做,
 * 点下去却告诉你回办公室 —— 那条待办不如不显示。
 *
 * 这一页做三件事,顺序就是收费员的实际顺序:
 *   ① 看这批有多少户、多少钱
 *   ② 逐户核对,把不该出的剔掉(线下已经交过的最常见)
 *   ③ 整批发布 —— 发布之后业主立刻能看到并缴费
 *
 * 「剔除」= 作废这一行草稿账单(可以重新出,但不可撤销),
 * 所以必须问一句原因:线下已收 / 不该出账。这两个答案进审计,
 * 下个月有人问「这户为什么没账单」时,这里是唯一的答案。
 */

const PAGE = 200;

Page({
  data: {
    loading: true,
    loadError: false,
    batches: [],
    busy: '',
  },

  onShow() {
    void this.load();
  },

  async load() {
    this.setData({ loading: true, loadError: false });
    try {
      const d = await adminRequest('/admin/bill-batches?status=DRAFT&pageSize=50', { silent: true });
      /*
       * 户数取「批次里还是草稿的账单条数」,不取批次上的 validRows ——
       * validRows 是生成那一刻写的,剔除过之后它就偏大了,
       * 而发布按钮上的户数写错就是当着人说谎。
       */
      const batches = await Promise.all(
        (d.list || []).map(async (b) => {
          const one = await adminRequest(`/admin/bills?batchId=${b.id}&status=DRAFT&pageSize=1`, { silent: true });
          return {
            id: b.id,
            title: b.title || b.batchNo,
            period: b.period,
            count: one.total || 0,
            amount: b.totalAmount,
            removed: 0,
            expanded: false,
            rows: [],
            truncated: false,
          };
        }),
      );
      /*
       * 一条草稿批次都不能藏起来,哪怕它已经被剔干净(0 户待发)。
       * 首页那条待办是按「批次状态=草稿」数的:这里若把 0 户的过滤掉,
       * 待办说有 1 件事、点进来说「没有待发布的账单」—— 红点永远消不掉。
       * 0 户的批次照样列出来,给它「整批不发」这条出路。
       */
      this.setData({ batches });
    } catch (e) {
      this.setData({ loadError: true });
    } finally {
      this.setData({ loading: false });
    }
  },

  async toggle(e) {
    const i = Number(e.currentTarget.dataset.i);
    const b = this.data.batches[i];
    if (b.expanded) return this.setData({ [`batches[${i}].expanded`]: false });
    this.setData({ [`batches[${i}].expanded`]: true });
    if (b.rows.length > 0) return;
    const d = await adminRequest(`/admin/bills?batchId=${b.id}&status=DRAFT&page=1&pageSize=${PAGE}`, { silent: true });
    this.setData({
      [`batches[${i}].rows`]: (d.list || []).map((x) => ({
        id: x.id,
        name: (x.house && (x.house.displayName || x.house.code)) || '',
        amount: x.amount,
        title: x.title,
      })),
      // 截断要说出来:显示 200 条却有 548 条,人会以为核对完了
      [`batches[${i}].truncated`]: (d.total || 0) > PAGE ? d.total : 0,
    });
  },

  async removeBill(e) {
    const i = Number(e.currentTarget.dataset.i);
    const j = Number(e.currentTarget.dataset.j);
    const b = this.data.batches[i];
    const row = b.rows[j];
    const reason = await new Promise((resolve) =>
      wx.showActionSheet({
        itemList: ['线下已经收过这户的钱', '这户本期本来不该出账'],
        success: (r) => resolve(['线下已收,手机端剔除', '本期不该出账,手机端剔除'][r.tapIndex]),
        fail: () => resolve(''),
      }),
    );
    if (!reason) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: `剔除 ${row.name}`,
        content: `原因:${reason}。剔除后这户本期没有账单(以后仍可重新出账)。`,
        confirmText: '剔除',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;
    this.setData({ busy: row.id });
    try {
      await adminRequest(`/admin/bills/${row.id}/cancel`, {
        method: 'POST',
        data: { reason, requestId: `mp-cancel-${row.id}` },
      });
      const rows = b.rows.filter((x) => x.id !== row.id);
      this.setData({
        [`batches[${i}].rows`]: rows,
        [`batches[${i}].count`]: Math.max(0, b.count - 1),
        [`batches[${i}].removed`]: b.removed + 1,
      });
      wx.showToast({ title: '已剔除', icon: 'none' });
    } finally {
      this.setData({ busy: '' });
    }
  },

  /*
   * 整批不发 —— 草稿必须有第二条出路。
   * 只有「发布」一条路时,一个不该发的草稿(历史遗留规则自动生成的那种)
   * 会永久占着待办红点,人最后会去点发布。
   */
  async cancelBatch(e) {
    const i = Number(e.currentTarget.dataset.i);
    const b = this.data.batches[i];
    const reason = await new Promise((resolve) =>
      wx.showActionSheet({
        itemList: ['这批算错了,重新出', '这批本来就不该出', '线下已经全部收过'],
        success: (r) => resolve(['算错了,重新出账', '本来不该出这批', '线下已全部收过'][r.tapIndex]),
        fail: () => resolve(''),
      }),
    );
    if (!reason) return;
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '整批不发',
        content: `原因:${reason}。这批 ${b.count} 户的草稿账单全部作废,业主始终没看到过。以后可以重新出账。`,
        confirmText: '整批作废',
        confirmColor: '#c45656',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;
    this.setData({ busy: b.id });
    try {
      await adminRequest(`/admin/bill-batches/${b.id}/cancel`, {
        method: 'POST',
        data: { reason, requestId: `mp-batch-cancel-${b.id}` },
      });
      wx.showToast({ title: '已整批作废', icon: 'none' });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },

  async publish(e) {
    const i = Number(e.currentTarget.dataset.i);
    const b = this.data.batches[i];
    if (b.count === 0) return wx.showToast({ title: '这批已经没有要发的户了', icon: 'none' });
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '发布这一批',
        content: `发布后 ${b.count} 户业主立即能在小程序看到账单并缴费${b.removed > 0 ? `(已剔除 ${b.removed} 户不发)` : ''}。发布之后不能再往这一批里加人。确认发布?`,
        confirmText: '发布',
        success: (r) => resolve(r.confirm),
      }),
    );
    if (!ok) return;
    this.setData({ busy: b.id });
    try {
      await adminRequest(`/admin/bill-batches/${b.id}/publish`, {
        method: 'POST',
        data: { requestId: `mp-publish-${b.id}` },
      });
      wx.showToast({ title: `已发布,${b.count} 户可见`, icon: 'success' });
      await this.load();
    } finally {
      this.setData({ busy: '' });
    }
  },
});
