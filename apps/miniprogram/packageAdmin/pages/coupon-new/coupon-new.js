const { adminRequest } = require('../../../utils/admin');

/*
 * 发卡券(仅物业管理员) —— 电影票、服务券、物业费抵扣券都从这里发出去。
 *
 * 发出去 = 业主立刻能在「我的卡券」里领,所以确认前把三件事摆在眼前:
 * 发多少张、每人限几张、有效期到哪天。发行量就是成本承诺,写错了只能改小不能撤回
 * (已领到业主手里的收不回来)。
 */

const TYPES = [
  { v: 'GIFT', label: '礼品券', hint: '电影票、实物奖品,业主领了到前台核销' },
  { v: 'SERVICE', label: '服务券', hint: '免上门费这类服务,同样凭码核销' },
  { v: 'DISCOUNT', label: '抵扣券', hint: '缴物业费时直接抵钱,需填面额' },
];

Page({
  data: {
    communityId: '',
    types: TYPES,
    type: 'GIFT',
    typeHint: TYPES[0].hint,
    name: '',
    faceValue: '',
    threshold: '',
    description: '',
    totalQty: '',
    perUserLimit: '1',
    validFrom: '',
    validTo: '',
    today: '',
    saving: false,
    /*
     * 发放方式:claim = 业主自领(先到先得);auto = 满足条件自动发。
     * 自动发只统计**线上微信支付**,条件之间是「且」;
     * 自动发的券不会出现在业主的「可领取」里(缴费换来的,不能被白领库存)。
     */
    grantMode: 'claim',
    minAmount: '',
    requireOnTime: false,
    requireNoArrears: false,
  },

  onLoad(q) {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.setData({ communityId: q.communityId || '', today: iso, validFrom: iso });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.k]: e.detail.value });
  },
  pickType(e) {
    const v = e.currentTarget.dataset.v;
    this.setData({ type: v, typeHint: TYPES.find((t) => t.v === v).hint });
  },
  pickGrantMode(e) {
    this.setData({ grantMode: e.currentTarget.dataset.v });
  },
  toggleOnTime() {
    this.setData({ requireOnTime: !this.data.requireOnTime });
  },
  toggleNoArrears() {
    this.setData({ requireNoArrears: !this.data.requireNoArrears });
  },

  onFrom(e) {
    this.setData({ validFrom: e.detail.value });
  },
  onTo(e) {
    this.setData({ validTo: e.detail.value });
  },

  async submit() {
    if (this.data.saving) return;
    const name = this.data.name.trim();
    if (!name) return wx.showToast({ title: '请填券名称,如「电影票兑换券」', icon: 'none' });
    const totalQty = Number(this.data.totalQty);
    if (!Number.isInteger(totalQty) || totalQty < 1) {
      return wx.showToast({ title: '发行总量要是大于 0 的整数', icon: 'none' });
    }
    const perUserLimit = Number(this.data.perUserLimit || 1);
    if (!Number.isInteger(perUserLimit) || perUserLimit < 1) {
      return wx.showToast({ title: '每人限领要是大于 0 的整数', icon: 'none' });
    }
    if (!this.data.validTo) return wx.showToast({ title: '请选有效期截止日', icon: 'none' });
    if (this.data.validTo < this.data.validFrom) {
      return wx.showToast({ title: '截止日不能早于开始日', icon: 'none' });
    }
    const faceValue = String(this.data.faceValue).trim();
    if (this.data.type === 'DISCOUNT' && !(Number(faceValue) > 0)) {
      return wx.showToast({ title: '抵扣券必须填面额', icon: 'none' });
    }
    const auto = this.data.grantMode === 'auto';
    const minAmount = String(this.data.minAmount).trim();
    if (auto && minAmount && !(Number(minAmount) > 0)) {
      return wx.showToast({ title: '金额门槛要是大于 0 的数', icon: 'none' });
    }
    if (auto && !minAmount && !this.data.requireOnTime && !this.data.requireNoArrears) {
      return wx.showToast({ title: '自动发至少要设一个条件', icon: 'none' });
    }

    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '确认发券',
        content: auto
          ? `「${name}」共 ${totalQty} 张,每人限领 ${perUserLimit} 张,有效期至 ${this.data.validTo}。业主线上缴费满足条件时自动发到他的卡券里${minAmount ? `(实付满 ${minAmount} 元)` : ''};发行量只能改小,已发出的收不回来。`
          : `「${name}」共 ${totalQty} 张,每人限领 ${perUserLimit} 张,有效期至 ${this.data.validTo}。发布后业主立刻能领取;发行量只能改小,已领出的收不回来。`,
        confirmText: '发布',
        success: (r) => resolve(r.confirm),
        // 弹窗失败也必须把 Promise 收掉,否则界面永久卡在「处理中」
        fail: () => resolve(false),
      }),
    );
    if (!ok) return;

    this.setData({ saving: true });
    try {
      await adminRequest('/admin/coupons', {
        method: 'POST',
        data: {
          communityId: this.data.communityId || undefined,
          name,
          type: this.data.type,
          totalQty,
          perUserLimit,
          validFrom: this.data.validFrom,
          validTo: this.data.validTo,
          ...(faceValue ? { faceValue: Number(faceValue) } : {}),
          ...(String(this.data.threshold).trim() ? { threshold: Number(this.data.threshold) } : {}),
          ...(this.data.description.trim() ? { description: this.data.description.trim() } : {}),
          ...(auto
            ? {
                autoGrant: {
                  ...(minAmount ? { minAmount: Number(minAmount) } : {}),
                  ...(this.data.requireOnTime ? { requireOnTime: true } : {}),
                  ...(this.data.requireNoArrears ? { requireNoArrears: true } : {}),
                },
              }
            : {}),
        },
      });
      const again = await new Promise((resolve) =>
        wx.showModal({
          title: '已发布',
          content: auto
            ? '规则已生效:业主线上缴费满足条件时,券会自动发到他的卡券里。'
            : '业主现在就能在「我的 → 我的卡券」里领取了。',
          confirmText: '好',
          showCancel: true,
          cancelText: '再发一张',
          success: (r) => resolve(!r.confirm),
          fail: () => resolve(false),
        }),
      );
      if (again) {
        this.setData({ name: '', totalQty: '', faceValue: '', threshold: '', description: '' });
      } else {
        wx.navigateBack();
      }
    } finally {
      this.setData({ saving: false });
    }
  },
});
