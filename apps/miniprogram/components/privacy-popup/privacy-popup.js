Component({
  data: { show: false },

  lifetimes: {
    attached() {
      // 当调用受隐私保护的接口（如 getPhoneNumber）且用户未同意时，微信触发此回调
      if (wx.onNeedPrivacyAuthorization) {
        this._privacyListener = (resolve) => {
          this._resolve = resolve;
          this.setData({ show: true });
        };
        wx.onNeedPrivacyAuthorization(this._privacyListener);
      }
    },
    detached() {
      if (wx.offNeedPrivacyAuthorization && this._privacyListener) {
        wx.offNeedPrivacyAuthorization(this._privacyListener);
      }
      this._privacyListener = null;
      this._resolve = null;
    },
  },

  methods: {
    openContract() {
      if (wx.openPrivacyContract) wx.openPrivacyContract({});
    },
    onAgree() {
      this.setData({ show: false });
      if (this._resolve) this._resolve({ event: 'agree', buttonId: 'agree-privacy-btn' });
      this._resolve = null;
    },
    onDisagree() {
      this.setData({ show: false });
      if (this._resolve) this._resolve({ event: 'disagree' });
      this._resolve = null;
      wx.showToast({ title: '未同意隐私保护指引，相关功能不可用', icon: 'none' });
    },
  },
});
