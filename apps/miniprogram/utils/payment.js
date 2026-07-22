function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPaymentConfirmation(orderNo, options = {}) {
  const attempts = options.attempts || 5;
  const intervalMs = options.intervalMs === undefined ? 1000 : options.intervalMs;
  const requestFn = options.requestFn || require('./request').request;
  const sleepFn = options.sleepFn || sleep;
  let result = { orderNo, status: 'CREATED' };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      result = await requestFn(`/owner/payments/${orderNo}/sync`, {
        method: 'POST',
        silent: true,
      });
      if (result.status === 'SUCCESS') return result;
      if (result.status === 'FAILED' || result.status === 'CLOSED') {
        const error = new Error(result.status === 'CLOSED' ? '支付订单已关闭' : '支付未成功');
        error.paymentStatus = result.status;
        throw error;
      }
    } catch (error) {
      if (error && error.paymentStatus) throw error;
    }
    if (attempt < attempts - 1) await sleepFn(intervalMs);
  }
  return result;
}

module.exports = { waitForPaymentConfirmation };
