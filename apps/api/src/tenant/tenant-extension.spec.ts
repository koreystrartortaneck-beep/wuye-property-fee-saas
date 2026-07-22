import { PrismaClient } from '@prisma/client';
import { ErrorCode } from '@pf/shared';
import { createTenantedClient, TENANT_MODELS } from './tenant-extension';

const tenantDelegates = [
  ['BillBatch', 'billBatch'],
  ['Refund', 'refund'],
  ['RefundAttempt', 'refundAttempt'],
  ['ReconciliationRun', 'reconciliationRun'],
  ['ReconciliationItem', 'reconciliationItem'],
  ['AuditLog', 'auditLog'],
  ['PaymentEvent', 'paymentEvent'],
  ['IdempotencyRecord', 'idempotencyRecord'],
  ['OutboxEvent', 'outboxEvent'],
  ['InvoiceApplication', 'invoiceApplication'],
  ['TenantCollectionPolicy', 'tenantCollectionPolicy'],
  ['CommunityCollectionPolicy', 'communityCollectionPolicy'],
] as const;

type CreateDelegate = {
  create(args: { data: Record<string, never> }): Promise<unknown>;
};

describe('finance models tenant isolation', () => {
  const raw = new PrismaClient();
  const tenanted = createTenantedClient(raw);

  afterAll(async () => {
    await raw.$disconnect();
  });

  it.each(tenantDelegates)('%s writes cannot bypass tenant-extension', async (modelName, delegateName) => {
    expect(TENANT_MODELS.has(modelName)).toBe(true);
    const delegate = (tenanted as unknown as Record<string, CreateDelegate>)[delegateName];

    await expect(
      Promise.resolve().then(() => delegate.create({ data: {} })),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
  });

  it('does not apply tenant filtering to the platform collection policy', async () => {
    expect(TENANT_MODELS.has('PlatformCollectionPolicy')).toBe(false);
    const delegate = (tenanted as unknown as Record<string, CreateDelegate>).platformCollectionPolicy;

    await expect(
      Promise.resolve().then(() => delegate.create({ data: {} })),
    ).rejects.not.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
  });
});
