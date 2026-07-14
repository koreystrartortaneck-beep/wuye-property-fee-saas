const { request } = require('../../utils/request');

Page({
  data: { r: null, loading: true, error: false, saving: false },

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
      // 缴费房屋以订单本身对应的房屋为准（后端返回），而非当前选中房屋
      const houseName = p.house ? `${p.house.communityName || ''} ${p.house.displayName || ''}`.trim() : '';
      this.setData({
        loading: false,
        error: false,
        r: {
          orderNo: p.orderNo || '',
          totalAmount: Number(p.totalAmount || 0).toFixed(2),
          paidAt: p.paidAt ? String(p.paidAt).replace('T', ' ').slice(0, 19) : '',
          houseName,
          items: (p.bills || []).map((b) => ({
            title: b.title || '费用',
            amount: Number(b.amount || 0).toFixed(2),
          })),
          success: p.status === 'SUCCESS',
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
    if (this.data.saving || !this.data.r) return;
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
      const H = 420 + r.items.length * rowH;
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
            ctx.fillStyle = '#2e1a47';
            ctx.textAlign = 'right';
            ctx.fillText('¥' + it.amount, W - 48, y);
            ctx.textAlign = 'left';
            y += rowH;
          });
          y += 4;
          this._line(ctx, W, y);
          y += 40;
          const rows = [
            ['缴费房屋', r.houseName || '—'],
            ['订单编号', r.orderNo],
            ['支付时间', r.paidAt || '—'],
            ['支付方式', '微信支付'],
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
