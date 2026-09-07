const { ensureAdmin, adminRequest } = require('../../../utils/admin');
const createReceiptPage = require('../../../utils/receipt-page');
const page = createReceiptPage(async function(orderNo) {
  await ensureAdmin();
  return adminRequest('/admin/payments/' + encodeURIComponent(orderNo) + '/receipt', { silent: true });
});
delete page.onShareAppMessage;
delete page.onShareTimeline;
const onLoad = page.onLoad;
page.onLoad = function(options) { wx.hideShareMenu();onLoad.call(this,options); };
Page(page);
