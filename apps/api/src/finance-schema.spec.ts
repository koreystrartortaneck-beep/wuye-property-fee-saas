import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import * as Shared from '@pf/shared';

type DmmfField = {
  name: string;
  kind: string;
  type: string;
  isRequired: boolean;
  isList: boolean;
  isUnique: boolean;
  hasDefaultValue: boolean;
  default?: unknown;
  isUpdatedAt: boolean;
  relationFromFields?: string[];
  relationToFields?: string[];
};

type DmmfModel = {
  name: string;
  fields: DmmfField[];
  uniqueFields: string[][];
};

type DmmfEnum = {
  name: string;
  values: Array<{ name: string }>;
};

const dmmf = (Prisma as unknown as {
  dmmf: { datamodel: { models: DmmfModel[]; enums: DmmfEnum[] } };
}).dmmf;
const modelByName = new Map(dmmf.datamodel.models.map((model) => [model.name, model]));
const enumByName = new Map(
  dmmf.datamodel.enums.map((item) => [item.name, item.values.map((value) => value.name)]),
);
const sharedEnums = Shared as unknown as Record<string, readonly string[]>;
const migrationSql = readFileSync(
  join(__dirname, '../prisma/migrations/20260722010000_finance_expand/migration.sql'),
  'utf8',
);
const normalizedMigrationSql = migrationSql.replace(/\s+/g, ' ').trim();

const tenantModels = [
  'BillBatch',
  'Refund',
  'RefundAttempt',
  'ReconciliationRun',
  'ReconciliationItem',
  'AuditLog',
  'PaymentEvent',
  'IdempotencyRecord',
  'OutboxEvent',
  'InvoiceApplication',
  'TenantCollectionPolicy',
  'CommunityCollectionPolicy',
] as const;

const enumContracts: Record<string, { shared: string; values: string[] }> = {
  BillBatchStatus: {
    shared: 'BILL_BATCH_STATUSES',
    values: ['DRAFT', 'GENERATING', 'READY', 'PUBLISHED', 'FAILED', 'CANCELED'],
  },
  BillSource: { shared: 'BILL_SOURCES', values: ['RULE', 'IMPORT'] },
  PaymentConfirmationSource: {
    shared: 'PAYMENT_CONFIRMATION_SOURCES',
    values: ['WXPAY_NOTIFY', 'WXPAY_QUERY', 'OFFLINE', 'MOCK'],
  },
  RefundType: { shared: 'REFUND_TYPES', values: ['FULL'] },
  RefundStatus: {
    shared: 'REFUND_STATUSES',
    values: ['CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'CLOSED', 'ABNORMAL'],
  },
  RefundAttemptStatus: {
    shared: 'REFUND_ATTEMPT_STATUSES',
    values: ['PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN'],
  },
  ReconciliationRunStatus: {
    shared: 'RECONCILIATION_RUN_STATUSES',
    values: ['RUNNING', 'COMPLETED', 'FAILED'],
  },
  ReconciliationBillType: {
    shared: 'RECONCILIATION_BILL_TYPES',
    values: ['TRANSACTION', 'REFUND'],
  },
  ReconciliationDifferenceType: {
    shared: 'RECONCILIATION_DIFFERENCE_TYPES',
    values: [
      'CHANNEL_MISSING',
      'LOCAL_MISSING',
      'AMOUNT_MISMATCH',
      'STATUS_MISMATCH',
      'REFUND_MISMATCH',
    ],
  },
  ReconciliationItemStatus: {
    shared: 'RECONCILIATION_ITEM_STATUSES',
    values: ['OPEN', 'AUTO_RESOLVED', 'MANUALLY_CLOSED', 'ESCALATED'],
  },
  AuditActorType: {
    shared: 'AUDIT_ACTOR_TYPES',
    values: ['SYSTEM', 'ADMIN', 'WX_USER'],
  },
  AuditAction: {
    shared: 'AUDIT_ACTIONS',
    values: ['CREATE', 'UPDATE', 'PUBLISH', 'CANCEL', 'PAY', 'REFUND', 'RECONCILE', 'INVOICE', 'RECOVER'],
  },
  PaymentEventType: {
    shared: 'PAYMENT_EVENT_TYPES',
    values: [
      'CREATED',
      'CHANNEL_ORDER_CREATED',
      'NOTIFIED',
      'CONFIRMED',
      'CLOSED',
      'FAILED',
      'REFUNDING',
      'REFUNDED',
      'RECOVERED',
    ],
  },
  PaymentEventStatus: {
    shared: 'PAYMENT_EVENT_STATUSES',
    values: ['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'],
  },
  IdempotencyStatus: {
    shared: 'IDEMPOTENCY_STATUSES',
    values: ['PROCESSING', 'SUCCEEDED', 'FAILED'],
  },
  OutboxEventStatus: {
    shared: 'OUTBOX_EVENT_STATUSES',
    values: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'],
  },
  InvoiceTitleType: {
    shared: 'INVOICE_TITLE_TYPES',
    values: ['PERSONAL', 'ENTERPRISE'],
  },
  InvoiceApplicationStatus: {
    shared: 'INVOICE_APPLICATION_STATUSES',
    values: [
      'SUBMITTED',
      'PROCESSING',
      'ISSUED',
      'REJECTED',
      'CANCELED',
      'REVERSAL_REQUIRED',
      'REVERSED',
    ],
  },
  CollectionPolicyStatus: {
    shared: 'COLLECTION_POLICY_STATUSES',
    values: ['OPEN', 'PAUSED'],
  },
};

function fieldsFor(modelName: string): Map<string, DmmfField> {
  const model = modelByName.get(modelName);
  expect(model).toBeDefined();
  return new Map(model?.fields.map((field) => [field.name, field]));
}

function expectField(
  modelName: string,
  fieldName: string,
  contract: Partial<DmmfField>,
): DmmfField {
  const field = fieldsFor(modelName).get(fieldName);
  expect(field).toBeDefined();
  expect(field).toMatchObject(contract);
  return field as DmmfField;
}

function expectUnique(modelName: string, fields: string[]): void {
  const model = modelByName.get(modelName);
  expect(model).toBeDefined();
  if (fields.length === 1) {
    expect(model?.fields.find((field) => field.name === fields[0])).toMatchObject({ isUnique: true });
    return;
  }
  expect(model?.uniqueFields).toContainEqual(fields);
}

function expectRelation(
  modelName: string,
  fieldName: string,
  fromFields: string[],
  toFields: string[],
): void {
  expectField(modelName, fieldName, {
    kind: 'object',
    relationFromFields: fromFields,
    relationToFields: toFields,
  });
}

describe('finance expansion Prisma contract', () => {
  it('keeps the legacy Bill and PaymentBill path while all expansion shortcuts stay nullable', () => {
    for (const fieldName of [
      'ruleId',
      'billRunId',
      'batchId',
      'source',
      'sourceRowKey',
      'publishedAt',
      'publishedBy',
      'canceledAt',
      'canceledBy',
      'cancelReason',
      'replacesBillId',
    ]) {
      expectField('Bill', fieldName, { isRequired: false, hasDefaultValue: false });
    }
    expectField('Bill', 'source', { kind: 'enum', type: 'BillSource' });
    expect(fieldsFor('Bill').has('voidedAt')).toBe(false);
    expect(fieldsFor('Bill').has('voidedBy')).toBe(false);
    expect(fieldsFor('Bill').has('voidReason')).toBe(false);

    expectUnique('Bill', ['ruleId', 'houseId', 'period']);
    expect(modelByName.get('Bill')?.uniqueFields).not.toContainEqual([
      'tenantId',
      'batchId',
      'houseId',
    ]);
    expectUnique('Bill', ['tenantId', 'batchId', 'sourceRowKey']);
    expectField('Bill', 'paymentBills', { kind: 'object', isList: true });
    expectField('Payment', 'paymentBills', { kind: 'object', isList: true });
    expectField('PaymentBill', 'paymentId', { isRequired: true, kind: 'scalar' });
    expectField('PaymentBill', 'billId', { isRequired: true, kind: 'scalar' });
  });

  it('adds a nullable fee category without assigning historical meaning', () => {
    expectField('FeeRule', 'category', {
      kind: 'scalar',
      type: 'String',
      isRequired: false,
      hasDefaultValue: false,
    });
  });

  it('defines RULE and IMPORT batches with source-specific metadata and totals', () => {
    const requiredFields = [
      'tenantId',
      'communityId',
      'source',
      'totalRows',
      'validRows',
      'invalidRows',
      'totalAmount',
      'status',
      'createdAt',
      'updatedAt',
    ];
    for (const fieldName of requiredFields) {
      expectField('BillBatch', fieldName, { isRequired: true });
    }
    expectField('BillBatch', 'source', {
      kind: 'enum',
      type: 'BillSource',
      hasDefaultValue: false,
    });
    for (const fieldName of [
      'ruleId',
      'importFileName',
      'importFileHash',
      'createdBy',
      'publishedAt',
      'publishedBy',
    ]) {
      expectField('BillBatch', fieldName, { isRequired: false });
    }
    for (const fieldName of ['totalRows', 'validRows', 'invalidRows', 'totalAmount']) {
      expectField('BillBatch', fieldName, { hasDefaultValue: true });
    }
  });

  it('supports legacy and offline payments without weakening payment identifiers', () => {
    for (const fieldName of ['wxUserId', 'billId', 'communityId']) {
      expectField('Payment', fieldName, { isRequired: false });
    }
    for (const fieldName of [
      'merchantAccountId',
      'mchid',
      'appid',
      'transactionId',
      'confirmedBy',
      'wxpayNotifiedAt',
      'expiresAt',
      'closedAt',
      'lastSyncedAt',
      'failureCode',
      'failureMessage',
      'receiptNo',
      'receiptSnapshot',
      'offlineVoucherNo',
      'offlinePaidAt',
      'offlineOperatorId',
      'offlinePayerSnapshot',
      'offlineRemark',
    ]) {
      expectField('Payment', fieldName, { isRequired: false });
    }
    expectField('Payment', 'confirmedBy', {
      kind: 'enum',
      type: 'PaymentConfirmationSource',
    });
    for (const fieldName of ['transactionId', 'receiptNo', 'offlineVoucherNo']) {
      expectUnique('Payment', [fieldName]);
    }
    expect(fieldsFor('Payment').get('billId')).toMatchObject({ isUnique: false });
    for (const forbiddenField of ['merchantSnapshot', 'offlineSnapshot', 'recoverySnapshot']) {
      expect(fieldsFor('Payment').has(forbiddenField)).toBe(false);
    }
  });

  it('models one refund aggregate per payment and keeps retry payloads summarized', () => {
    for (const fieldName of [
      'tenantId',
      'paymentId',
      'merchantAccountId',
      'mchid',
      'appid',
      'refundNo',
      'originalAmount',
      'refundAmount',
      'currency',
      'reason',
      'requestedBy',
      'requestedAt',
      'processingAt',
      'refundedAt',
      'notifyReceivedAt',
      'lastQueriedAt',
      'failedAt',
      'closedAt',
      'failureCode',
      'failureMessage',
    ]) {
      expect(fieldsFor('Refund').has(fieldName)).toBe(true);
    }
    expectField('Refund', 'communityId', { isRequired: false });
    expectField('Refund', 'providerRefundId', { isRequired: false, isUnique: true });
    expectUnique('Refund', ['paymentId']);
    expectUnique('Refund', ['refundNo']);

    for (const fieldName of [
      'requestHash',
      'requestSummary',
      'responseSummary',
      'status',
      'attemptedAt',
      'finishedAt',
    ]) {
      expect(fieldsFor('RefundAttempt').has(fieldName)).toBe(true);
    }
    for (const forbiddenField of [
      'requestSnapshot',
      'responseSnapshot',
      'rawRequest',
      'rawResponse',
    ]) {
      expect(fieldsFor('RefundAttempt').has(forbiddenField)).toBe(false);
    }
    expectUnique('RefundAttempt', ['tenantId', 'refundId', 'attemptNo']);
  });

  it('defines leased reconciliation runs and independently handled differences', () => {
    for (const fieldName of [
      'merchantAccountId',
      'mchid',
      'businessDate',
      'billType',
      'channelFileHash',
      'channelRecordCount',
      'channelAmount',
      'localRecordCount',
      'localAmount',
      'matchedRecordCount',
      'differenceRecordCount',
      'differenceAmount',
      'status',
      'leaseOwner',
      'leaseExpiresAt',
    ]) {
      expect(fieldsFor('ReconciliationRun').has(fieldName)).toBe(true);
    }
    expectField('ReconciliationRun', 'billType', {
      kind: 'enum',
      type: 'ReconciliationBillType',
    });
    expectUnique('ReconciliationRun', ['merchantAccountId', 'businessDate', 'billType']);

    for (const fieldName of [
      'orderNo',
      'differenceType',
      'status',
      'handledBy',
      'handledAt',
      'handlingRemark',
    ]) {
      expect(fieldsFor('ReconciliationItem').has(fieldName)).toBe(true);
    }
    expectField('ReconciliationItem', 'differenceType', {
      kind: 'enum',
      type: 'ReconciliationDifferenceType',
    });
    expectField('ReconciliationItem', 'status', {
      kind: 'enum',
      type: 'ReconciliationItemStatus',
    });
    expectUnique('ReconciliationItem', ['runId', 'orderNo', 'differenceType']);
  });

  it('stores explicit, bounded audit summaries and request context', () => {
    for (const fieldName of [
      'tenantId',
      'communityId',
      'actorType',
      'actorId',
      'action',
      'resourceType',
      'resourceId',
      'reason',
      'requestId',
      'ip',
      'userAgent',
      'beforeSummary',
      'afterSummary',
      'createdAt',
    ]) {
      expect(fieldsFor('AuditLog').has(fieldName)).toBe(true);
    }
    expectField('AuditLog', 'beforeSummary', { kind: 'scalar', type: 'Json' });
    expectField('AuditLog', 'afterSummary', { kind: 'scalar', type: 'Json' });
    expect(fieldsFor('AuditLog').has('beforeData')).toBe(false);
    expect(fieldsFor('AuditLog').has('afterData')).toBe(false);
  });

  it('gives idempotency, payment events, and outbox rows scoped keys plus claim/retry fields', () => {
    for (const modelName of ['IdempotencyRecord', 'PaymentEvent', 'OutboxEvent']) {
      expectField(modelName, 'tenantId', { isRequired: true });
      expectField(modelName, 'communityId', { isRequired: false });
      for (const fieldName of ['attempts', 'claimOwner', 'claimExpiresAt']) {
        expect(fieldsFor(modelName).has(fieldName)).toBe(true);
      }
    }

    for (const fieldName of ['actorKey', 'action', 'requestId', 'requestHash', 'nextRetryAt']) {
      expect(fieldsFor('IdempotencyRecord').has(fieldName)).toBe(true);
    }
    expectUnique('IdempotencyRecord', ['tenantId', 'actorKey', 'action', 'requestId']);

    expectField('PaymentEvent', 'paymentId', { isRequired: false });
    expectField('PaymentEvent', 'refundId', { isRequired: false });
    for (const fieldName of ['eventKey', 'status', 'availableAt', 'processedAt', 'lastError']) {
      expect(fieldsFor('PaymentEvent').has(fieldName)).toBe(true);
    }
    expectUnique('PaymentEvent', ['tenantId', 'eventKey']);

    expectField('OutboxEvent', 'dedupKey', { isRequired: true });
    for (const fieldName of ['availableAt', 'lastAttemptAt', 'publishedAt', 'lastError']) {
      expect(fieldsFor('OutboxEvent').has(fieldName)).toBe(true);
    }
    expectUnique('OutboxEvent', ['tenantId', 'dedupKey']);
  });

  it('requires an invoice delivery method and one tenant-scoped application per payment', () => {
    for (const fieldName of ['tenantId', 'communityId', 'paymentId', 'wxUserId', 'deliveryMethod']) {
      expectField('InvoiceApplication', fieldName, { isRequired: true });
    }
    for (const fieldName of ['reversalRequiredAt', 'reversedAt', 'reversalRemark']) {
      expectField('InvoiceApplication', fieldName, { isRequired: false });
    }
    expectUnique('InvoiceApplication', ['applicationNo']);
    expectUnique('InvoiceApplication', ['tenantId', 'paymentId']);
  });

  it('uses OPEN/PAUSED state and change attribution at all three policy levels', () => {
    for (const modelName of [
      'PlatformCollectionPolicy',
      'TenantCollectionPolicy',
      'CommunityCollectionPolicy',
    ]) {
      expectField(modelName, 'status', {
        kind: 'enum',
        type: 'CollectionPolicyStatus',
        isRequired: true,
      });
      for (const fieldName of ['changedBy', 'reason', 'changedAt', 'resumeAt']) {
        expect(fieldsFor(modelName).has(fieldName)).toBe(true);
      }
      expect(fieldsFor(modelName).has('enabled')).toBe(false);
    }
    expect(fieldsFor('PlatformCollectionPolicy').has('tenantId')).toBe(false);
    expectField('TenantCollectionPolicy', 'tenantId', { isRequired: true });
    expectField('CommunityCollectionPolicy', 'tenantId', { isRequired: true });
  });

  it('adds every tenant finance model to the schema and keeps platform policy global', () => {
    for (const modelName of tenantModels) {
      expectField(modelName, 'tenantId', { isRequired: true, kind: 'scalar' });
    }
    expect(modelByName.get('PlatformCollectionPolicy')).toBeDefined();
    expect(fieldsFor('PlatformCollectionPolicy').has('tenantId')).toBe(false);
  });

  it('matches every changed Prisma enum to a hard-coded contract and shared runtime values', () => {
    expect(enumByName.get('BillStatus')).toEqual([
      'UNPAID',
      'PAID',
      'CANCELED',
      'DRAFT',
      'REFUNDING',
      'REFUNDED',
    ]);
    expect(enumByName.get('PaymentStatus')).toEqual([
      'CREATED',
      'SUCCESS',
      'FAILED',
      'CLOSED',
      'REFUNDED',
      'PREPAY_UNKNOWN',
    ]);
    expect(enumByName.get('PaymentChannel')).toEqual(['MOCK', 'WXPAY', 'OFFLINE']);

    for (const [prismaName, contract] of Object.entries(enumContracts)) {
      expect(enumByName.get(prismaName)).toEqual(contract.values);
      expect(sharedEnums[contract.shared]).toEqual(contract.values);
    }
  });

  it('uses tenant-matching foreign keys for all tenant-owned finance relations', () => {
    const relationContracts = [
      ['House', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['Bill', 'house', ['tenantId', 'houseId'], ['tenantId', 'id']],
      ['Bill', 'rule', ['tenantId', 'ruleId'], ['tenantId', 'id']],
      ['Bill', 'billRun', ['tenantId', 'billRunId'], ['tenantId', 'id']],
      ['Bill', 'batch', ['tenantId', 'batchId'], ['tenantId', 'id']],
      ['Bill', 'replacesBill', ['tenantId', 'replacesBillId'], ['tenantId', 'id']],
      ['Bill', 'publisher', ['tenantId', 'publishedBy'], ['tenantId', 'id']],
      ['Bill', 'canceler', ['tenantId', 'canceledBy'], ['tenantId', 'id']],
      ['Payment', 'bill', ['tenantId', 'billId'], ['tenantId', 'id']],
      ['Payment', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['Payment', 'offlineOperator', ['tenantId', 'offlineOperatorId'], ['tenantId', 'id']],
      ['BillBatch', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['BillBatch', 'rule', ['tenantId', 'ruleId'], ['tenantId', 'id']],
      ['Refund', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['Refund', 'bill', ['tenantId', 'billId'], ['tenantId', 'id']],
      ['Refund', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['RefundAttempt', 'refund', ['tenantId', 'refundId'], ['tenantId', 'id']],
      ['RefundAttempt', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['ReconciliationRun', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['ReconciliationItem', 'run', ['tenantId', 'runId'], ['tenantId', 'id']],
      ['ReconciliationItem', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['ReconciliationItem', 'refund', ['tenantId', 'refundId'], ['tenantId', 'id']],
      ['ReconciliationItem', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['PaymentEvent', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['PaymentEvent', 'refund', ['tenantId', 'refundId'], ['tenantId', 'id']],
      ['PaymentEvent', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['IdempotencyRecord', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['OutboxEvent', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['InvoiceApplication', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['InvoiceApplication', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['PlatformCollectionPolicy', 'changer', ['changedBy'], ['id']],
      ['TenantCollectionPolicy', 'tenant', ['tenantId'], ['id']],
      ['TenantCollectionPolicy', 'changer', ['tenantId', 'changedBy'], ['tenantId', 'id']],
      ['CommunityCollectionPolicy', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['CommunityCollectionPolicy', 'tenantPolicy', ['tenantId', 'tenantPolicyId'], ['tenantId', 'id']],
      ['CommunityCollectionPolicy', 'changer', ['tenantId', 'changedBy'], ['tenantId', 'id']],
    ] as const;

    for (const [modelName, fieldName, fromFields, toFields] of relationContracts) {
      expectRelation(modelName, fieldName, [...fromFields], [...toFields]);
    }
  });

  it('gives every new @updatedAt field a database default for non-Prisma writers', () => {
    for (const modelName of [
      'BillBatch',
      'Refund',
      'IdempotencyRecord',
      'OutboxEvent',
      'InvoiceApplication',
      'PlatformCollectionPolicy',
      'TenantCollectionPolicy',
      'CommunityCollectionPolicy',
    ]) {
      expectField(modelName, 'updatedAt', {
        isRequired: true,
        isUpdatedAt: true,
        hasDefaultValue: true,
      });
    }
  });
});

describe('finance expansion SQL contract', () => {
  it('is expansion-only and contains no data rewrite or destructive statement', () => {
    const statements = migrationSql
      .split(';')
      .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);

    for (const statement of statements) {
      expect(statement).not.toMatch(/^(UPDATE|DELETE|DROP|RENAME|TRUNCATE)\b/i);
      if (/^ALTER\s+TABLE\b/i.test(statement)) {
        expect(statement).not.toMatch(/\b(DROP|RENAME|CHANGE)\b/i);
      }
    }
  });

  it('adds Bill source as nullable without a default and only loosens legacy rule links', () => {
    const billAlter = normalizedMigrationSql.match(/ALTER TABLE `Bill` .*?;/)?.[0];
    expect(billAlter).toBeDefined();
    expect(billAlter).toMatch(/ADD COLUMN `source` ENUM\('RULE', 'IMPORT'\) NULL/);
    expect(billAlter).not.toMatch(/`source`[^,;]*\bDEFAULT\b/);
    expect(billAlter).not.toMatch(/`source`[^,;]*\bNOT NULL\b/);
    expect(billAlter).toMatch(/MODIFY `ruleId` VARCHAR\(191\) NULL/);
    expect(billAlter).toMatch(/MODIFY `billRunId` VARCHAR\(191\) NULL/);
    expect(billAlter).toMatch(/ADD COLUMN `sourceRowKey` VARCHAR\(191\) NULL/);
    expect(billAlter).toMatch(/ADD COLUMN `canceledAt` DATETIME\(3\) NULL/);
    expect(billAlter).not.toMatch(/voided|voidReason/i);
  });

  it('leaves historical FeeRule and Payment rows compatible', () => {
    expect(normalizedMigrationSql).toMatch(
      /ALTER TABLE `FeeRule` ADD COLUMN `category` VARCHAR\(191\) NULL;/,
    );
    const paymentAlter = normalizedMigrationSql.match(/ALTER TABLE `Payment` .*?;/)?.[0];
    expect(paymentAlter).toBeDefined();
    expect(paymentAlter).toMatch(/MODIFY `wxUserId` VARCHAR\(191\) NULL/);
    for (const fieldName of ['merchantAccountId', 'mchid', 'appid']) {
      expect(paymentAlter).toMatch(
        new RegExp('ADD COLUMN `' + fieldName + '` VARCHAR\\(191\\) NULL'),
      );
    }
  });

  it('enforces batch source exclusivity and polymorphic payment event ownership with CHECKs', () => {
    expect(normalizedMigrationSql).toMatch(
      /CONSTRAINT `BillBatch_source_fields_chk` CHECK .*`source` = 'RULE'.*`ruleId` IS NOT NULL.*`source` = 'IMPORT'.*`importFileName` IS NOT NULL.*`importFileHash` IS NOT NULL/,
    );
    expect(normalizedMigrationSql).toMatch(
      /CONSTRAINT `PaymentEvent_target_chk` CHECK .*`paymentId` IS NOT NULL.*`refundId` IS NULL.*`paymentId` IS NULL.*`refundId` IS NOT NULL/,
    );
  });

  it('enforces offline completeness, full refunds, and attributed collection pauses with CHECKs', () => {
    expect(normalizedMigrationSql).toMatch(
      /CONSTRAINT `Payment_offline_fields_chk` CHECK .*`channel` <> 'OFFLINE'.*`offlineVoucherNo` IS NOT NULL.*`offlinePaidAt` IS NOT NULL.*`offlineOperatorId` IS NOT NULL.*`offlinePayerSnapshot` IS NOT NULL/,
    );
    expect(normalizedMigrationSql).toMatch(
      /CONSTRAINT `Refund_full_amount_chk` CHECK .*`type` = 'FULL'.*`refundAmount` = `originalAmount`/,
    );
    for (const constraintName of [
      'PlatformCollectionPolicy_pause_reason_chk',
      'TenantCollectionPolicy_pause_reason_chk',
      'CommunityCollectionPolicy_pause_reason_chk',
    ]) {
      expect(normalizedMigrationSql).toMatch(
        new RegExp(
          'CONSTRAINT `' + constraintName + '` CHECK .*`status` <> \'PAUSED\'.*`reason` IS NOT NULL.*`changedBy` IS NOT NULL',
        ),
      );
    }
  });

  it('uses RESTRICT updates for foreign keys whose columns participate in CHECK constraints', () => {
    for (const constraintName of [
      'BillBatch_tenantId_ruleId_fkey',
      'Payment_tenantId_offlineOperatorId_fkey',
      'PaymentEvent_tenantId_paymentId_fkey',
      'PaymentEvent_tenantId_refundId_fkey',
      'PlatformCollectionPolicy_changedBy_fkey',
      'TenantCollectionPolicy_tenantId_changedBy_fkey',
      'CommunityCollectionPolicy_tenantId_changedBy_fkey',
    ]) {
      expect(normalizedMigrationSql).toMatch(
        new RegExp(
          'CONSTRAINT `' + constraintName + '` FOREIGN KEY .* ON DELETE RESTRICT ON UPDATE RESTRICT',
        ),
      );
    }
  });

  it('creates the required unique indexes and tenant-matching foreign keys', () => {
    for (const indexSql of [
      'UNIQUE INDEX `Payment_transactionId_key` ON `Payment`(`transactionId`)',
      'UNIQUE INDEX `Payment_receiptNo_key` ON `Payment`(`receiptNo`)',
      'UNIQUE INDEX `Payment_offlineVoucherNo_key` ON `Payment`(`offlineVoucherNo`)',
      'UNIQUE INDEX `Refund_paymentId_key`(`paymentId`)',
      'UNIQUE INDEX `Refund_refundNo_key`(`refundNo`)',
      'UNIQUE INDEX `Refund_providerRefundId_key`(`providerRefundId`)',
      'UNIQUE INDEX `ReconciliationRun_merchantAccountId_businessDate_billType_key`(`merchantAccountId`, `businessDate`, `billType`)',
      'UNIQUE INDEX `ReconciliationItem_runId_orderNo_differenceType_key`(`runId`, `orderNo`, `differenceType`)',
      'UNIQUE INDEX `IdempotencyRecord_tenantId_actorKey_action_requestId_key`(`tenantId`, `actorKey`, `action`, `requestId`)',
      'UNIQUE INDEX `PaymentEvent_tenantId_eventKey_key`(`tenantId`, `eventKey`)',
      'UNIQUE INDEX `OutboxEvent_tenantId_dedupKey_key`(`tenantId`, `dedupKey`)',
      'UNIQUE INDEX `InvoiceApplication_tenantId_paymentId_key`(`tenantId`, `paymentId`)',
    ]) {
      expect(normalizedMigrationSql).toContain(indexSql);
    }

    for (const foreignKeySql of [
      'FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`)',
      'FOREIGN KEY (`tenantId`, `batchId`) REFERENCES `BillBatch`(`tenantId`, `id`)',
      'FOREIGN KEY (`tenantId`, `publishedBy`) REFERENCES `AdminUser`(`tenantId`, `id`)',
      'FOREIGN KEY (`tenantId`, `canceledBy`) REFERENCES `AdminUser`(`tenantId`, `id`)',
      'FOREIGN KEY (`tenantId`, `paymentId`) REFERENCES `Payment`(`tenantId`, `id`)',
      'FOREIGN KEY (`tenantId`, `communityId`) REFERENCES `Community`(`tenantId`, `id`)',
    ]) {
      expect(normalizedMigrationSql).toContain(foreignKeySql);
    }
  });
});
