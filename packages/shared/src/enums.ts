// 业务枚举 —— 取值与 Prisma schema 保持一致（spec §5）

export const HOUSE_TYPES = ['RESIDENCE', 'PARKING', 'SHOP'] as const;
export type HouseType = (typeof HOUSE_TYPES)[number];

export const RULE_TYPES = ['AREA_PRICE', 'FIXED', 'METER', 'SHARE', 'FORMULA'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_PERIODS = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type RulePeriod = (typeof RULE_PERIODS)[number];

export const METER_TYPES = ['WATER', 'ELEC', 'GAS'] as const;
export type MeterType = (typeof METER_TYPES)[number];

export const SHARE_BY = ['AREA', 'HOUSE'] as const;
export type ShareBy = (typeof SHARE_BY)[number];

export const BILL_STATUSES = ['UNPAID', 'PAID', 'CANCELED', 'DRAFT', 'REFUNDING', 'REFUNDED'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_RUN_STATUSES = ['RUNNING', 'DONE', 'FAILED'] as const;
export type BillRunStatus = (typeof BILL_RUN_STATUSES)[number];

export const PAYMENT_STATUSES = ['CREATED', 'SUCCESS', 'FAILED', 'CLOSED', 'REFUNDED', 'PREPAY_UNKNOWN'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_CHANNELS = ['MOCK', 'WXPAY', 'OFFLINE'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

export const BILL_BATCH_STATUSES = ['DRAFT', 'GENERATING', 'READY', 'PUBLISHED', 'FAILED', 'CANCELED'] as const;
export type BillBatchStatus = (typeof BILL_BATCH_STATUSES)[number];

export const BILL_SOURCES = ['RULE', 'IMPORT'] as const;
export type BillSource = (typeof BILL_SOURCES)[number];

export const PAYMENT_CONFIRMATION_SOURCES = ['WXPAY_NOTIFY', 'WXPAY_QUERY', 'OFFLINE', 'MOCK'] as const;
export type PaymentConfirmationSource = (typeof PAYMENT_CONFIRMATION_SOURCES)[number];

export const REFUND_TYPES = ['FULL'] as const;
export type RefundType = (typeof REFUND_TYPES)[number];

export const REFUND_STATUSES = ['CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'CLOSED', 'ABNORMAL'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_ATTEMPT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN'] as const;
export type RefundAttemptStatus = (typeof REFUND_ATTEMPT_STATUSES)[number];

export const RECONCILIATION_RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

export const RECONCILIATION_BILL_TYPES = ['TRANSACTION', 'REFUND'] as const;
export type ReconciliationBillType = (typeof RECONCILIATION_BILL_TYPES)[number];

export const RECONCILIATION_DIFFERENCE_TYPES = [
  'CHANNEL_MISSING',
  'LOCAL_MISSING',
  'AMOUNT_MISMATCH',
  'STATUS_MISMATCH',
  'REFUND_MISMATCH',
] as const;
export type ReconciliationDifferenceType = (typeof RECONCILIATION_DIFFERENCE_TYPES)[number];

export const RECONCILIATION_ITEM_STATUSES = [
  'OPEN',
  'AUTO_RESOLVED',
  'MANUALLY_CLOSED',
  'ESCALATED',
] as const;
export type ReconciliationItemStatus = (typeof RECONCILIATION_ITEM_STATUSES)[number];

export const AUDIT_ACTOR_TYPES = ['SYSTEM', 'ADMIN', 'WX_USER'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'PUBLISH',
  'CANCEL',
  'PAY',
  'REFUND',
  'RECONCILE',
  'INVOICE',
  'RECOVER',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const PAYMENT_EVENT_TYPES = [
  'CREATED',
  'CHANNEL_ORDER_CREATED',
  'NOTIFIED',
  'CONFIRMED',
  'CLOSED',
  'FAILED',
  'REFUNDING',
  'REFUNDED',
  'RECOVERED',
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export const PAYMENT_EVENT_STATUSES = ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'] as const;
export type PaymentEventStatus = (typeof PAYMENT_EVENT_STATUSES)[number];

export const IDEMPOTENCY_STATUSES = ['PROCESSING', 'SUCCEEDED', 'FAILED'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export const OUTBOX_EVENT_STATUSES = ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'] as const;
export type OutboxEventStatus = (typeof OUTBOX_EVENT_STATUSES)[number];

export const INVOICE_TITLE_TYPES = ['PERSONAL', 'ENTERPRISE'] as const;
export type InvoiceTitleType = (typeof INVOICE_TITLE_TYPES)[number];

export const INVOICE_APPLICATION_STATUSES = [
  'SUBMITTED',
  'PROCESSING',
  'ISSUED',
  'REJECTED',
  'CANCELED',
  'REVERSAL_REQUIRED',
  'REVERSED',
] as const;
export type InvoiceApplicationStatus = (typeof INVOICE_APPLICATION_STATUSES)[number];

export const COLLECTION_POLICY_STATUSES = ['OPEN', 'PAUSED'] as const;
export type CollectionPolicyStatus = (typeof COLLECTION_POLICY_STATUSES)[number];

export const BINDING_STATUSES = ['PENDING', 'ACTIVE', 'REJECTED'] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

export const BINDING_RELATIONS = ['OWNER', 'FAMILY', 'TENANT'] as const;
export type BindingRelation = (typeof BINDING_RELATIONS)[number];

export const BINDING_SOURCES = ['PHONE_MATCH', 'APPLY'] as const;
export type BindingSource = (typeof BINDING_SOURCES)[number];

export const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const NOTIFY_TYPES = ['BILL_CREATED', 'DUE_SOON', 'OVERDUE'] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export const NOTIFY_STATUSES = ['SENT', 'FAILED', 'SKIPPED'] as const;
export type NotifyStatus = (typeof NOTIFY_STATUSES)[number];

// ---------- 二期：工单 / 访客 / 公告 ----------

export const TICKET_TYPES = ['REPAIR', 'COMPLAINT', 'SUGGESTION'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const TICKET_STATUSES = ['PENDING', 'PROCESSING', 'DONE', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PASS_STATUSES = ['ACTIVE', 'USED', 'EXPIRED', 'CANCELED'] as const;
export type PassStatus = (typeof PASS_STATUSES)[number];

// ---------- 三期：工作照片墙 / 生活服务 / 卡券 ----------

export const WORK_CATEGORIES = ['INSPECTION', 'CLEANING', 'GREENING', 'SECURITY', 'REPAIR', 'OTHER'] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];

export const SERVICE_ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'DONE', 'CANCELED'] as const;
export type ServiceOrderStatus = (typeof SERVICE_ORDER_STATUSES)[number];

export const COUPON_TYPES = ['DISCOUNT', 'SERVICE', 'GIFT'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const USER_COUPON_STATUSES = ['UNUSED', 'USED', 'EXPIRED'] as const;
export type UserCouponStatus = (typeof USER_COUPON_STATUSES)[number];
