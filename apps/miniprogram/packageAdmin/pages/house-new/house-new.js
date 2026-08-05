const { adminRequest } = require('../../../utils/admin');

/*
 * 新增房屋 —— 物业自己建房、自己绑人,不用找开发。
 *
 * 一屏填完,不用滑。字段顺序按「不填就出不了账」排:
 *   房号(唯一) → 类型 → 面积 → 放户日期 → 住户手机 → 收费标准
 *
 * 两句必须说在前面的话:
 *   · 房号在本小区内唯一。填了已有的房号是**更新**那套房,不会出现两套同号的
 *     (后端按 (小区,房号) upsert)—— 界面如实说,免得有人以为自己新建了一套。
 *   · 面积和放户日期可以以后补,但补齐之前这套房出不了账。
 *     住宅是硬性要求(后端拒收没面积的住宅),所以住宅这里就挡住。
 */

const TYPES = [
  { v: 'RESIDENCE', label: '住宅' },
  { v: 'SHOP', label: '门市' },
  { v: 'PARKING', label: '车位' },
];

Page({
  data: {
    communityId: '',
    types: TYPES,
    type: 'RESIDENCE',
    code: '',
    displayName: '',
    area: '',
    handoverDate: '',
    phone: '',
    rules: [],
    ruleId: '',
    ruleName: '',
    pickingRule: false,
    today: '',
    saving: false,
    gridHint: '',
    gridWarn: false,
  },

  onLoad(q) {
    const d = new Date();
    this.setData({
      communityId: q.communityId || '',
      today: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    });
    void this.loadRules();
  },

  async loadRules() {
    try {
      const d = await adminRequest(`/admin/fee-rules?communityId=${this.data.communityId}&pageSize=100`, { silent: true });
      this.setData({
        rules: (d.list || [])
          .filter((r) => r.periodScheme === 'ANNIVERSARY' && r.enabled && r.code)
          .map((r) => ({ id: r.id, code: r.code || '', name: r.name, price: priceText(r) })),
      });
    } catch (e) {
      // 标准拉不到不挡建房:房可以先建,标准以后在房屋详情里挂
    }
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.k]: e.detail.value });
    if (e.currentTarget.dataset.k === 'code') this.previewGrid();
  },
  onHandover(e) {
    this.setData({ handoverDate: e.detail.value });
  },
  pickType(e) {
    this.setData({ type: e.currentTarget.dataset.v });
    this.previewGrid();
  },

  /*
   * 房号 → 楼盘图位置的实时预览。规则只在后端一处(parseHouseCode),
   * 这里现问,不复制一份 —— 复制的那份早晚和真的对不上。
   * 2026-08-05 用户建「003-013」进了「其他」组,以为没绑定到楼盘。
   */
  previewGrid() {
    clearTimeout(this._gridTimer);
    const code = this.data.code.trim();
    if (!code) return this.setData({ gridHint: '', gridWarn: false });
    this._gridTimer = setTimeout(async () => {
      try {
        const p = await adminRequest(
          `/admin/houses-grid/parse?type=${this.data.type}&code=${encodeURIComponent(code)}`,
          { silent: true },
        );
        if (p.code !== undefined && p.recognized === undefined) return; // 形状不对的响应,不装懂
        if (this.data.code.trim() !== code) return; // 回来时已经改了,别用旧答案
        this.setData(
          p.recognized
            ? {
                gridHint: `楼盘图归入:${p.building}${p.unit ? ' · ' + p.unit : ''}${p.floor > 0 ? ' · ' + p.floor + ' 层' : ''}`,
                gridWarn: false,
              }
            : {
                gridHint: '这个写法认不出楼栋,会归入「其他」。参考:A-3-702 / 2-1-1-1102 / G-001 / 商场M111',
                gridWarn: true,
              },
        );
      } catch (e) {
        this.setData({ gridHint: '', gridWarn: false }); // 预览挂了不挡建房
      }
    }, 350);
  },
  togglePickRule() {
    this.setData({ pickingRule: !this.data.pickingRule });
  },
  pickRule(e) {
    const r = this.data.rules[Number(e.currentTarget.dataset.i)];
    this.setData({ ruleId: r.id, ruleName: r.name, pickingRule: false });
  },
  clearRule() {
    this.setData({ ruleId: '', ruleName: '' });
  },

  async submit() {
    if (this.data.saving) return;
    const code = this.data.code.trim();
    if (!code) return wx.showToast({ title: '请填房号', icon: 'none' });
    const area = String(this.data.area).trim();
    if (area && !(Number(area) > 0)) return wx.showToast({ title: '面积要是大于 0 的数', icon: 'none' });
    if (this.data.type === 'RESIDENCE' && !area) {
      return wx.showToast({ title: '住宅必须填建筑面积', icon: 'none' });
    }
    const phone = this.data.phone.trim();
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      return wx.showToast({ title: '手机号是 11 位', icon: 'none' });
    }

    const row = {
      type: this.data.type,
      code,
      displayName: this.data.displayName.trim() || code,
      ...(area ? { area: Number(area) } : {}),
      ...(this.data.handoverDate ? { handoverDate: this.data.handoverDate } : {}),
      ...(phone ? { contactPhones: phone } : {}),
    };
    /*
     * 挂标准走 standardCodes(代号),不是 ruleId —— 导入接口按代号解析。
     * 没代号的标准这里不给挂,建完房去房屋详情里挂(那条路是按 id 的)。
     */
    const rule = this.data.rules.find((r) => r.id === this.data.ruleId);
    if (rule && rule.code) row.standardCodes = rule.code;

    this.setData({ saving: true });
    try {
      const r = await adminRequest('/admin/houses/import', {
        method: 'POST',
        data: { communityId: this.data.communityId, rows: [row] },
      });
      if (r.failed && r.failed.length > 0) {
        wx.showModal({ title: '没有建成', content: r.failed[0].reason || '这一行没能保存', showCancel: false });
        return;
      }
      // 如实区分「新建」与「覆盖了已有的同号房」
      const updated = r.updated > 0;
      const found = await adminRequest(
        `/admin/houses?communityId=${this.data.communityId}&keyword=${encodeURIComponent(code)}&page=1&pageSize=5`,
        { silent: true },
      );
      const house = (found.list || []).find((h) => h.code === code);
      /*
       * confirmText / cancelText 最多 4 个字。
       * 2026-08-04 实测:这里原来写「去看这套房」(5 字)—— 微信直接走 fail,
       * 而当时没接 fail,Promise 永不 resolve,finally 也不执行,
       * 界面就永久停在「保存中…」。房其实已经建好了,只有界面在骗人。
       */
      const ok = await new Promise((resolve) =>
        wx.showModal({
          title: updated ? '已更新这套房' : '已建好',
          content: [
            updated ? `${code} 本来就在库里,这次是更新它的信息(不会出现两套同号的房)。` : `${code} 已建好。`,
            phone ? '住户手机号已登记 —— 对方在小程序授权手机号后就能看到这套房的账单。' : '',
            rule ? `已挂「${rule.name}」,以后按它出账。` : '还没挂收费标准 —— 不挂不出账,可在房屋详情里挂。',
          ]
            .filter(Boolean)
            .join('\n'),
          confirmText: house ? '去看看' : '好',
          showCancel: !!house,
          cancelText: '再建一套',
          success: (x) => resolve(x.confirm),
          // 弹窗失败(文案超长/已有弹窗在显示)也必须把 Promise 收掉,否则界面永久卡在「处理中」
          fail: () => resolve(false),
        }),
      );
      if (ok && house) {
        wx.redirectTo({ url: `/packageAdmin/pages/house/house?id=${house.id}` });
      } else {
        this.setData({ code: '', displayName: '', area: '', phone: '' });
      }
    } finally {
      this.setData({ saving: false });
    }
  },
});

function priceText(rule) {
  const p = rule.params || {};
  if (rule.ruleType === 'AREA_PRICE') return `${p.unitPrice} 元/㎡/月`;
  if (rule.ruleType === 'FIXED') return `固定 ${p.amount} 元`;
  return '';
}
