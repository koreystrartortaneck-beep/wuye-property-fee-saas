/**
 * 微信支付回调地址的自检。
 *
 * 2026-08-01 事故的收尾：两笔已扣款的支付一直没入账，最后确认**微信回调从未到达**
 * （WX_PAY_ALLOWED_TENANT_ID 已配置，所以验签失败必然会写 CRITICAL 告警，
 * 而告警表是 0 条 —— 没被拒，是没来过）。
 *
 * 而「回调地址对不对」这件事，此前没有任何地方能看出来：
 *   · WX_PAY_NOTIFY_URL 是必需环境变量，所以它一定有值 —— 但值可以是错的
 *   · 真实路由是 /api/v1/payment/wxpay/notify，漏掉 /api/v1 前缀极易发生
 *   · 退款回调地址由 notifyUrl.replace(/\/notify$/, '/refund-notify') 推出来：
 *     若 notifyUrl 不以 /notify 结尾，替换不发生，两个地址变成同一个，
 *     退款回调会打到支付回调的处理器上并静默失败
 * 配错的唯一表现就是「钱扣了但账单不变」，而这恰恰最像后端 bug，最难指向配置。
 *
 * 所以把这些判据写成可断言的函数，并在就绪检查里回显。
 */

/** Nest 全局前缀（setup-app.ts: app.setGlobalPrefix('api/v1')）+ 控制器路径 */
export const WXPAY_NOTIFY_PATH = '/api/v1/payment/wxpay/notify';
export const WXPAY_REFUND_NOTIFY_PATH = '/api/v1/payment/wxpay/refund-notify';

export type CallbackUrlIssue = { code: string; detail: string };

/**
 * 检查一对回调地址的形状。返回空数组表示没发现问题。
 *
 * 只做静态判断（不发网络请求）：就绪检查会被频繁调用，不该每次都外呼。
 * 连通性由 /admin/operations/callback-probe 单独实测。
 */
export function inspectCallbackUrls(
  notifyUrl: string | undefined,
  refundNotifyUrl: string | undefined,
): CallbackUrlIssue[] {
  const issues: CallbackUrlIssue[] = [];
  if (!notifyUrl) {
    issues.push({ code: 'NOTIFY_URL_MISSING', detail: '未配置 WX_PAY_NOTIFY_URL' });
    return issues;
  }

  let parsed: URL;
  try {
    parsed = new URL(notifyUrl);
  } catch {
    issues.push({ code: 'NOTIFY_URL_MALFORMED', detail: `WX_PAY_NOTIFY_URL 不是合法 URL：${notifyUrl}` });
    return issues;
  }

  if (parsed.protocol !== 'https:') {
    issues.push({ code: 'NOTIFY_URL_NOT_HTTPS', detail: '微信只会向 HTTPS 地址发回调' });
  }
  if (parsed.pathname !== WXPAY_NOTIFY_PATH) {
    /*
     * 最常见的形态是漏掉 /api/v1 前缀。写清「期望 vs 实际」而不是只说「路径不对」——
     * 配置的人需要能直接照着改。
     */
    issues.push({
      code: 'NOTIFY_URL_PATH_MISMATCH',
      detail: `回调路径应为 ${WXPAY_NOTIFY_PATH}，实际是 ${parsed.pathname}`,
    });
  }

  const refund = refundNotifyUrl || notifyUrl.replace(/\/notify$/, '/refund-notify');
  if (refund === notifyUrl) {
    issues.push({
      code: 'REFUND_URL_COLLIDES',
      detail: '退款回调地址与支付回调地址相同：退款回调会打到支付回调的处理器上并静默失败',
    });
  } else {
    try {
      const rp = new URL(refund);
      if (rp.pathname !== WXPAY_REFUND_NOTIFY_PATH) {
        issues.push({
          code: 'REFUND_URL_PATH_MISMATCH',
          detail: `退款回调路径应为 ${WXPAY_REFUND_NOTIFY_PATH}，实际是 ${rp.pathname}`,
        });
      }
    } catch {
      issues.push({ code: 'REFUND_URL_MALFORMED', detail: `退款回调地址不是合法 URL：${refund}` });
    }
  }
  return issues;
}

/** 供界面显示：只给出主机与路径，不带查询串（回调地址本身不含密钥，但没必要多显示） */
export function describeCallbackUrl(notifyUrl: string | undefined): string {
  if (!notifyUrl) return '(未配置)';
  try {
    const u = new URL(notifyUrl);
    return `${u.host}${u.pathname}`;
  } catch {
    return notifyUrl;
  }
}
