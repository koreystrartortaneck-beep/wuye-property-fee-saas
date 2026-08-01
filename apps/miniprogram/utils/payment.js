function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待支付结果确认。
 *
 * 真实事故：业主付款成功，这里连查 5 次（每次间隔 1 秒，总共约 5 秒）都没等到入账，
 * 于是放弃并提示「请稍后查看」；而后台的自动补救要等订单创建满 30 分钟才动 ——
 * 业主在这半小时里看到的是「钱扣了、账单还是待缴」，什么解释都没有。
 *
 * 改成退避重试：查 7 次，间隔 1s → 2s → 3s → 4s → 5s → 5s，
 * 等待累计 20 秒（加上 7 次请求本身的耗时，实际约 22~25 秒）。
 * 微信的入账通知绝大多数在几秒内到，偶发慢一点也能在这个窗口内等到。
 * 再拉长意义不大 —— 那已属异常，应交给后台补救并把话说清楚，
 * 而不是让人对着转圈。
 *
 * 退避而不是固定 1 秒：前几秒是最可能成功的时刻，多试；之后放缓，少打服务端。
 */
const BACKOFF_MS = [1000, 2000, 3000, 4000, 5000, 5000];

async function waitForPaymentConfirmation(orderNo, options = {}) {
  const backoff = options.backoffMs || BACKOFF_MS;
  const attempts = options.attempts || backoff.length + 1;
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
      // 终态错误立即抛出；网络类错误继续重试（下一次可能就通了）
      if (error && error.paymentStatus) throw error;
    }
    if (attempt < attempts - 1) {
      await sleepFn(backoff[Math.min(attempt, backoff.length - 1)]);
    }
  }
  return result;
}

module.exports = { waitForPaymentConfirmation };
