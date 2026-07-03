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

export const BILL_STATUSES = ['UNPAID', 'PAID', 'CANCELED'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_RUN_STATUSES = ['RUNNING', 'DONE', 'FAILED'] as const;
export type BillRunStatus = (typeof BILL_RUN_STATUSES)[number];

export const PAYMENT_STATUSES = ['CREATED', 'SUCCESS', 'FAILED', 'CLOSED', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_CHANNELS = ['MOCK', 'WXPAY'] as const;
export type PaymentChannel = (typeof PAYMENT_CHANNELS)[number];

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
