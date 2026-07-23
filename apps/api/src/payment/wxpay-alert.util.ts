import { AlertService } from '../operations/alert.service';

/**
 * 微信回调验签拒绝告警：回调无租户上下文，按配置的灰度商户范围
 * （WX_PAY_ALLOWED_TENANT_ID / WX_PAY_ALLOWED_COMMUNITY_ID）归属并去重。
 * 未配置灰度范围时不触发（无法归属租户）；任何异常都不影响 401 响应。
 */
export async function emitCallbackRejectedAlert(
  alerts: AlertService | null | undefined,
  alertType: 'PAYMENT_CALLBACK_REJECTED' | 'REFUND_CALLBACK_REJECTED',
  title: string,
  message: string,
): Promise<void> {
  if (!alerts) return;
  const tenantId = process.env.WX_PAY_ALLOWED_TENANT_ID;
  if (!tenantId) return;
  const hourBucket = new Date().toISOString().slice(0, 13);
  await alerts.safeEmit({
    tenantId,
    communityId: process.env.WX_PAY_ALLOWED_COMMUNITY_ID || null,
    alertType,
    severity: 'CRITICAL',
    dedupKey: `${alertType}:${hourBucket}`,
    title,
    summary: message,
  });
}
