import { describe, it, expect } from 'vitest';
import { AUDIT_ACTION_LABEL, BILL_BATCH_STATUS_LABEL, BILL_STATUS_LABEL, COLLECTION_STATUS_LABEL, INVOICE_STATUS_LABEL, PAYMENT_CHANNEL_LABEL, PAYMENT_STATUS_LABEL, RECON_DIFF_LABEL, RECON_ITEM_STATUS_LABEL, RECON_RUN_STATUS_LABEL, REFUND_STATUS_LABEL, billStatusTag, buildOfflinePayload, buildReasonPayload, buildRefundPayload, day, dt, genRequestId, invoiceStatusTag, paymentStatusTag, reconItemStatusTag, refundStatusTag, shanghaiToday, yuan } from './finance';

describe('finance label maps', () => {
  it('covers every bill status including new draft/refund states', () => {
    for (const k of ['UNPAID', 'PAID', 'CANCELED', 'DRAFT', 'REFUNDING', 'REFUNDED']) {
      expect(BILL_STATUS_LABEL[k]).toBeTruthy();
    }
  });
  it('covers batch, payment, refund, reconciliation, invoice, collection, audit maps', () => {
    for (const k of ['DRAFT', 'GENERATING', 'READY', 'PUBLISHED', 'FAILED', 'CANCELED']) {
      expect(BILL_BATCH_STATUS_LABEL[k]).toBeTruthy();
    }
    for (const k of ['CREATED', 'SUCCESS', 'FAILED', 'CLOSED', 'REFUNDED', 'PREPAY_UNKNOWN']) {
      expect(PAYMENT_STATUS_LABEL[k]).toBeTruthy();
    }
    for (const k of ['MOCK', 'WXPAY', 'OFFLINE']) expect(PAYMENT_CHANNEL_LABEL[k]).toBeTruthy();
    for (const k of ['CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'CLOSED', 'ABNORMAL']) {
      expect(REFUND_STATUS_LABEL[k]).toBeTruthy();
    }
    for (const k of ['RUNNING', 'COMPLETED', 'FAILED']) expect(RECON_RUN_STATUS_LABEL[k]).toBeTruthy();
    for (const k of ['CHANNEL_MISSING', 'LOCAL_MISSING', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'REFUND_MISMATCH']) {
      expect(RECON_DIFF_LABEL[k]).toBeTruthy();
    }
    for (const k of ['OPEN', 'AUTO_RESOLVED', 'MANUALLY_CLOSED', 'ESCALATED']) {
      expect(RECON_ITEM_STATUS_LABEL[k]).toBeTruthy();
    }
    for (const k of ['SUBMITTED', 'PROCESSING', 'ISSUED', 'REJECTED', 'CANCELED', 'REVERSAL_REQUIRED', 'REVERSED']) {
      expect(INVOICE_STATUS_LABEL[k]).toBeTruthy();
    }
    for (const k of ['OPEN', 'PAUSED']) expect(COLLECTION_STATUS_LABEL[k]).toBeTruthy();
    for (const k of ['CREATE', 'UPDATE', 'PUBLISH', 'CANCEL', 'PAY', 'REFUND', 'RECONCILE', 'INVOICE', 'RECOVER']) {
      expect(AUDIT_ACTION_LABEL[k]).toBeTruthy();
    }
  });
});

describe('status tag types', () => {
  it('maps success/danger correctly', () => {
    expect(billStatusTag('PAID')).toBe('success');
    expect(billStatusTag('REFUNDED')).toBe('info');
    expect(paymentStatusTag('SUCCESS')).toBe('success');
    expect(paymentStatusTag('FAILED')).toBe('danger');
    expect(refundStatusTag('SUCCESS')).toBe('success');
    expect(refundStatusTag('ABNORMAL')).toBe('danger');
    expect(reconItemStatusTag('OPEN')).toBe('danger');
    expect(reconItemStatusTag('AUTO_RESOLVED')).toBe('success');
    expect(invoiceStatusTag('ISSUED')).toBe('success');
    expect(invoiceStatusTag('REJECTED')).toBe('danger');
  });
});

describe('genRequestId', () => {
  it('returns unique non-empty ids with prefix', () => {
    const a = genRequestId('refund');
    const b = genRequestId('refund');
    expect(a).toMatch(/^refund-/);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });
});

describe('yuan', () => {
  it('formats to 2 decimals', () => {
    expect(yuan('12')).toBe('12.00');
    expect(yuan(3.1)).toBe('3.10');
    expect(yuan(null)).toBe('0.00');
  });
});

describe('payload builders', () => {
  it('refund payload always carries orderNo/reason/requestId and never a client amount', () => {
    const p = buildRefundPayload('WY1', '业主申请');
    expect(p.orderNo).toBe('WY1');
    expect(p.reason).toBe('业主申请');
    expect(p.requestId).toMatch(/^refund-/);
    expect('amount' in p).toBe(false);
  });
  it('reason payload requires a non-empty reason', () => {
    expect(buildReasonPayload('原因')).toMatchObject({ reason: '原因' });
    expect(buildReasonPayload('原因').requestId).toBeTruthy();
    expect(() => buildReasonPayload('  ')).toThrow();
  });
  it('offline payload maps form fields and requires bill/voucher/paidAt', () => {
    const p = buildOfflinePayload({ billId: 'B1', voucherNo: 'V1', paidAt: '2026-07-01T10:00', payerName: '张三', remark: 'r' });
    expect(p).toMatchObject({ billId: 'B1', voucherNo: 'V1', payerName: '张三', remark: 'r' });
    expect(p.paidAt).toBeTruthy();
    expect(p.requestId).toMatch(/^offline-/);
    expect(() => buildOfflinePayload({ billId: '', voucherNo: 'V1', paidAt: '2026-07-01T10:00' })).toThrow();
    expect(() => buildOfflinePayload({ billId: 'B1', voucherNo: '', paidAt: '2026-07-01T10:00' })).toThrow();
    expect(() => buildOfflinePayload({ billId: 'B1', voucherNo: 'V1', paidAt: '' })).toThrow();
  });
});


describe('时间按 Asia/Shanghai 呈现（后端返回 UTC ISO）', () => {
  it('dt 把 UTC 转北京时间，而非直接截断字符串', () => {
    // 01:30Z = 北京 09:30；此前会显示成 01:30
    expect(dt('2026-07-25T01:30:00.000Z')).toBe('2026-07-25 09:30');
  });

  it('跨日：UTC 前一天傍晚 = 北京次日凌晨', () => {
    // 07-24T18:00Z = 北京 07-25 02:00；此前会少显示一天
    expect(day('2026-07-24T18:00:00.000Z')).toBe('2026-07-25');
    expect(dt('2026-07-24T18:00:00.000Z')).toBe('2026-07-25 02:00');
  });

  it('空值与非法值返回占位符，不出现 Invalid Date', () => {
    expect(dt(null)).toBe('—');
    expect(dt('')).toBe('—');
    expect(dt('not-a-date')).toBe('—');
    expect(day(undefined)).toBe('—');
    expect(day('not-a-date')).toBe('—');
  });

  it('shanghaiToday 与北京当日日期一致', () => {
    expect(day(shanghaiToday())).toBe(day(new Date()));
  });
});
