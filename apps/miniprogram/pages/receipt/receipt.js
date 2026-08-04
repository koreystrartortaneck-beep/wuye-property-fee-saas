const { request } = require('../../utils/request');
const { fmtDateTimeSec } = require('../../utils/datetime');

Page({
  data: { r: null, loading: true, error: false, noReceipt: false, saving: false },

  onLoad(options) {
    this.orderNo = options.orderNo || '';
    this.load();
  },

  async load() {
    if (!this.orderNo) {
      this.setData({ loading: false, error: true });
      return;
    }
    this.setData({ loading: true, error: false });
    try {
      await getApp().loginReady;
      const p = await request(`/owner/payments/${this.orderNo}`, { silent: true });
      // 仅渲染后端不可变收据快照；无快照（未成功）视为无收据
      const snap = p.receipt;
      if (!snap) {
        this.setData({ loading: false, error: false, r: null, noReceipt: true });
        return;
      }
      this.setData({
        loading: false,
        error: false,
        noReceipt: false,
        r: {
          receiptNo: snap.receiptNo || '',
          orderNo: snap.orderNo || p.orderNo || '',
          totalAmount: Number(snap.totalAmount || p.totalAmount || 0).toFixed(2),
          paidAt: fmtDateTimeSec(snap.paidAt),
          houseName: `${snap.community || ''} ${snap.house || ''}`.trim(),
          /*
           * 明细 = 各张账单原价 + 券抵扣行。
           *
           * 只列账单的话，各行之和是原价（比如 1200），而上方「实收金额」是扣券后的
           * 1180 —— 这张收据自己对不上账，凭空少 20 元。而本页明确写着
           * 「可发送给他人或用于报销」，对不上账的凭证会被财务退回。
           *
           * 历史订单的快照没有 discountAmount 字段（快照不可变），此时不显示这一行 ——
           * 那些订单本来也没有用券，不显示是正确的。
           */
          items: [
            ...(snap.bills || []).map((b) => ({
              title: b.title || '费用',
              amount: Number(b.amount || 0).toFixed(2),
              negative: false,
            })),
            ...(Number(snap.discountAmount || 0) > 0
              ? [{ title: '优惠券抵扣', amount: Number(snap.discountAmount).toFixed(2), negative: true }]
              : []),
          ],
          // 收据有效性完全由后端派生：退款订单标记作废
          void: !!p.receiptVoid,
          success: !p.receiptVoid,
        },
      });
    } catch (e) {
      this.setData({ loading: false, error: true });
    }
  },

  retry() {
    this.load();
  },

  /** 绘制收据为图片并保存到相册（替代不可行的"长按截图"） */
  async saveReceipt() {
    if (this.data.saving || !this.data.r || this.data.r.void) return;
    this.setData({ saving: true });
    try {
      const filePath = await this.drawToImage();
      await this.saveToAlbum(filePath);
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      if (e && e.errMsg && e.errMsg.indexOf('auth deny') === -1 && e.errMsg.indexOf('cancel') === -1) {
        wx.showToast({ title: '保存失败，可长按截图', icon: 'none' });
      }
    } finally {
      this.setData({ saving: false });
    }
  },

  drawToImage() {
    const r = this.data.r;
    return new Promise((resolve, reject) => {
      const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
      const W = 620;
      const rowH = 46;
      // +120：给信息行下方的收讫章留出空白带（否则章会压住支付时间那行）
      const H = 540 + r.items.length * rowH;
      const query = wx.createSelectorQuery();
      query
        .select('#receiptCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) {
            reject(new Error('no canvas'));
            return;
          }
          const canvas = res[0].node;
          canvas.width = W * dpr;
          canvas.height = H * dpr;
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          // 背景
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, W, H);
          let y = 64;
          ctx.fillStyle = '#2e1a47';
          ctx.font = 'bold 40px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('电 子 收 据', W / 2, y);
          y += 28;
          ctx.fillStyle = '#b08d57';
          ctx.font = '20px sans-serif';
          ctx.fillText('RECEIPT', W / 2, y);
          y += 60;
          ctx.fillStyle = '#8a8a8a';
          ctx.font = '22px sans-serif';
          ctx.fillText('实收金额（元）', W / 2, y);
          y += 56;
          ctx.fillStyle = '#2e1a47';
          ctx.font = 'bold 60px sans-serif';
          ctx.fillText('¥ ' + r.totalAmount, W / 2, y);
          y += 50;
          this._line(ctx, W, y);
          y += 24;
          // 明细
          ctx.font = '26px sans-serif';
          ctx.textAlign = 'left';
          r.items.forEach((it) => {
            ctx.fillStyle = '#555';
            ctx.fillText(it.title, 48, y);
            // 抵扣行带负号，与屏幕上以及缴费确认页的写法一致（−¥20.00）
            ctx.fillStyle = it.negative ? '#9b743a' : '#2e1a47';
            ctx.textAlign = 'right';
            ctx.fillText((it.negative ? '−¥' : '¥') + it.amount, W - 48, y);
            ctx.textAlign = 'left';
            y += rowH;
          });
          y += 4;
          this._line(ctx, W, y);
          y += 40;
          const rows = [
            ['收据编号', r.receiptNo || '—'],
            ['缴费房屋', r.houseName || '—'],
            ['订单编号', r.orderNo],
            ['支付时间', r.paidAt || '—'],
          ];
          ctx.font = '24px sans-serif';
          rows.forEach((row) => {
            ctx.fillStyle = '#8a8a8a';
            ctx.textAlign = 'left';
            ctx.fillText(row[0], 48, y);
            ctx.fillStyle = '#333';
            ctx.textAlign = 'right';
            ctx.fillText(String(row[1]), W - 48, y);
            y += 44;
          });
          ctx.textAlign = 'left';
          /*
           * 收讫章也要画进图里。
           *
           * 屏幕上有红色「收讫」印章，而保存到相册的图原本没有 ——
           * 业主发出去的凭证与他自己看到的不是同一张东西，
           * 而收到的人（财务、房东）看不到这个已收款标记。
           * （作废的收据不允许保存，所以这里只画收讫。）
           */
          this._stamp(ctx, W, y);
          setTimeout(() => {
            wx.canvasToTempFilePath({
              canvas,
              success: (rr) => resolve(rr.tempFilePath),
              fail: reject,
            });
          }, 60);
        });
    });
  },

  /** 收讫章：圆圈 + 旋转文字，位置在信息行下方的空白带，避免压住房号 */
  _stamp(ctx, W, y) {
    const cx = W - 118;
    const cy = y + 40;
    const rad = 56;
    ctx.save();
    ctx.strokeStyle = 'rgba(196, 86, 86, 0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.translate(cx, cy);
    ctx.rotate((-18 * Math.PI) / 180);
    ctx.fillStyle = 'rgba(196, 86, 86, 0.8)';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('收讫', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  },

  _line(ctx, W, y) {
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(W - 40, y);
    ctx.stroke();
  },

  saveToAlbum(filePath) {
    return new Promise((resolve, reject) => {
      const doSave = () =>
        wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject });
      wx.getSetting({
        success: (s) => {
          if (s.authSetting['scope.writePhotosAlbum'] === false) {
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置里开启"保存到相册"权限',
              confirmText: '去设置',
              success: (m) => {
                if (m.confirm) wx.openSetting({ complete: () => reject(new Error('reopen')) });
                else reject(new Error('cancel'));
              },
              // 弹窗自己失败时也要把 Promise 收掉,否则「保存到相册」永远转圈
              fail: () => reject(new Error('modal-fail')),
            });
          } else {
            doSave();
          }
        },
        fail: doSave,
      });
    });
  },
});
