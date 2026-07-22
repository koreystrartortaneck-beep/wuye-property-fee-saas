import { Prisma } from '@prisma/client';
import * as Shared from '@pf/shared';

type DmmfField = {
  name: string;
  kind: string;
  isRequired: boolean;
  isList: boolean;
  hasDefaultValue: boolean;
  relationFromFields?: string[];
  relationToFields?: string[];
};

type DmmfModel = {
  name: string;
  fields: DmmfField[];
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

const enumContracts: Record<string, string> = {
  BillBatchStatus: 'BILL_BATCH_STATUSES',
  BillSource: 'BILL_SOURCES',
  RefundType: 'REFUND_TYPES',
  RefundStatus: 'REFUND_STATUSES',
  RefundAttemptStatus: 'REFUND_ATTEMPT_STATUSES',
  ReconciliationRunStatus: 'RECONCILIATION_RUN_STATUSES',
  ReconciliationItemType: 'RECONCILIATION_ITEM_TYPES',
  ReconciliationItemStatus: 'RECONCILIATION_ITEM_STATUSES',
  AuditActorType: 'AUDIT_ACTOR_TYPES',
  AuditAction: 'AUDIT_ACTIONS',
  PaymentEventType: 'PAYMENT_EVENT_TYPES',
  IdempotencyStatus: 'IDEMPOTENCY_STATUSES',
  OutboxEventStatus: 'OUTBOX_EVENT_STATUSES',
  InvoiceTitleType: 'INVOICE_TITLE_TYPES',
  InvoiceApplicationStatus: 'INVOICE_APPLICATION_STATUSES',
  CollectionMode: 'COLLECTION_MODES',
};

describe('finance expansion Prisma contract', () => {
  it('keeps legacy Bill and PaymentBill paths while new Payment shortcuts stay optional', () => {
    const billFields = new Map(modelByName.get('Bill')?.fields.map((field) => [field.name, field]));
    const paymentFields = new Map(modelByName.get('Payment')?.fields.map((field) => [field.name, field]));
    const paymentBillFields = new Map(modelByName.get('PaymentBill')?.fields.map((field) => [field.name, field]));

    expect(billFields.get('ruleId')).toMatchObject({ isRequired: true, kind: 'scalar' });
    expect(billFields.get('billRunId')).toMatchObject({ isRequired: true, kind: 'scalar' });
    expect(billFields.get('paymentBills')).toMatchObject({ kind: 'object', isList: true });
    expect(paymentFields.get('wxUserId')).toMatchObject({ isRequired: true, kind: 'scalar' });
    expect(paymentFields.get('paymentBills')).toMatchObject({ kind: 'object', isList: true });
    expect(paymentBillFields.get('paymentId')).toMatchObject({ isRequired: true, kind: 'scalar' });
    expect(paymentBillFields.get('billId')).toMatchObject({ isRequired: true, kind: 'scalar' });

    for (const fieldName of ['billId', 'communityId']) {
      expect(paymentFields.get(fieldName)).toMatchObject({ isRequired: false, kind: 'scalar' });
    }
  });

  it('adds every tenant finance model with an explicit tenant key and keeps the platform policy global', () => {
    for (const modelName of tenantModels) {
      const model = modelByName.get(modelName);
      expect(model).toBeDefined();
      expect(model?.fields.find((field) => field.name === 'tenantId')).toMatchObject({
        isRequired: true,
        kind: 'scalar',
      });
    }

    const platformPolicy = modelByName.get('PlatformCollectionPolicy');
    expect(platformPolicy).toBeDefined();
    expect(platformPolicy?.fields.some((field) => field.name === 'tenantId')).toBe(false);
  });

  it('keeps legacy enum ordinals and exposes expanded statuses through shared runtime enums', () => {
    expect(enumByName.get('BillStatus')?.slice(0, 3)).toEqual(['UNPAID', 'PAID', 'CANCELED']);
    expect(enumByName.get('BillStatus')).toEqual(
      expect.arrayContaining(['DRAFT', 'REFUNDING', 'REFUNDED']),
    );
    expect(enumByName.get('PaymentStatus')?.slice(0, 5)).toEqual([
      'CREATED',
      'SUCCESS',
      'FAILED',
      'CLOSED',
      'REFUNDED',
    ]);
    expect(enumByName.get('PaymentStatus')).toContain('PREPAY_UNKNOWN');
    expect(enumByName.get('PaymentChannel')?.slice(0, 2)).toEqual(['MOCK', 'WXPAY']);
    expect(enumByName.get('PaymentChannel')).toContain('OFFLINE');

    for (const [prismaName, sharedName] of Object.entries(enumContracts)) {
      expect(enumByName.get(prismaName)).toBeDefined();
      expect(sharedEnums[sharedName]).toEqual(enumByName.get(prismaName));
    }
  });

  it('uses tenant-matching foreign keys for every tenant-owned finance relation', () => {
    const relationContracts = [
      ['Bill', 'batch', ['tenantId', 'batchId'], ['tenantId', 'id']],
      ['Bill', 'replacesBill', ['tenantId', 'replacesBillId'], ['tenantId', 'id']],
      ['Payment', 'bill', ['tenantId', 'billId'], ['tenantId', 'id']],
      ['Payment', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['BillBatch', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['Refund', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['Refund', 'bill', ['tenantId', 'billId'], ['tenantId', 'id']],
      ['RefundAttempt', 'refund', ['tenantId', 'refundId'], ['tenantId', 'id']],
      ['ReconciliationItem', 'run', ['tenantId', 'runId'], ['tenantId', 'id']],
      ['ReconciliationItem', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['ReconciliationItem', 'refund', ['tenantId', 'refundId'], ['tenantId', 'id']],
      ['PaymentEvent', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['InvoiceApplication', 'payment', ['tenantId', 'paymentId'], ['tenantId', 'id']],
      ['TenantCollectionPolicy', 'tenant', ['tenantId'], ['id']],
      ['CommunityCollectionPolicy', 'community', ['tenantId', 'communityId'], ['tenantId', 'id']],
      ['CommunityCollectionPolicy', 'tenantPolicy', ['tenantId', 'tenantPolicyId'], ['tenantId', 'id']],
    ] as const;

    for (const [modelName, fieldName, fromFields, toFields] of relationContracts) {
      const relation = modelByName.get(modelName)?.fields.find((field) => field.name === fieldName);
      expect(relation).toMatchObject({
        relationFromFields: [...fromFields],
        relationToFields: [...toFields],
      });
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
      expect(modelByName.get(modelName)?.fields.find((field) => field.name === 'updatedAt')).toMatchObject({
        isRequired: true,
        hasDefaultValue: true,
      });
    }
  });
});
