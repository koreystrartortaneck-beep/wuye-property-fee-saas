const { ensureAdmin, adminRequest } = require('../../../utils/admin');
const createReceiptPage = require('../../../utils/receipt-page');
const page = createReceiptPage(async function(orderNo) {
  await ensureAdmin();
  try {
    return await adminRequest('/admin/payments/' + encodeURIComponent(orderNo) + '/receipt', { silent: true });
  } catch (e) {
    if(e.code === 40400) {
      e.receiptMessage = '收据暂时无法查看';
      e.receiptHint = '请联系物业管理员核查，或稍后重试';
    } else if(e.code === 40100 || e.code === 40300) {
      e.receiptMessage = '无法查看该收据';
      e.receiptHint = '请重新进入物业管理，确认账号权限';
    }
    throw e;
  }
});
delete page.onShareAppMessage;
delete page.onShareTimeline;
const onLoad = page.onLoad;
page.onLoad = function(options) { wx.hideShareMenu();onLoad.call(this,options); };
Page(page);
