import { Prisma, PrismaClient } from '@prisma/client';
import { ErrorCode } from '@pf/shared';
import { createTenantedClient, TENANT_MODELS } from './tenant-extension';
import { runWithTenant } from './tenant-cls';

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

type CapturedOperation = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

type OperationInvoker = (
  model: string,
  operation: string,
  args?: CapturedOperation,
) => Promise<CapturedOperation>;

function createCapturingClient() {
  const fake = {
    $extends(extension: unknown): unknown {
      if (typeof extension === 'function') {
        return (extension as (client: unknown) => unknown)(fake);
      }
      const operation = (extension as {
        query: {
          $allModels: {
            $allOperations(args: {
              model: string;
              operation: string;
              args: CapturedOperation;
              query(nextArgs: CapturedOperation): Promise<CapturedOperation>;
            }): Promise<CapturedOperation>;
          };
        };
      }).query.$allModels.$allOperations;
      const invoke = (operationName: string, args: CapturedOperation) =>
        operation({
          model: 'OutboxEvent',
          operation: operationName,
          args,
          query: async (nextArgs) => nextArgs,
        });
      return {
        outboxEvent: {
          create: (args: CapturedOperation) => invoke('create', args),
          update: (args: CapturedOperation) => invoke('update', args),
          upsert: (args: CapturedOperation) => invoke('upsert', args),
        },
      };
    },
  };
  return createTenantedClient(fake as never) as unknown as {
    outboxEvent: {
      create(args: CapturedOperation): Promise<CapturedOperation>;
      update(args: CapturedOperation): Promise<CapturedOperation>;
      upsert(args: CapturedOperation): Promise<CapturedOperation>;
    };
  };
}

function createOperationHarness() {
  const rawPlatformCreate = jest.fn(async (args: CapturedOperation) => args);
  const query = jest.fn(async (args: CapturedOperation) => args);
  const fake = {
    platformCollectionPolicy: { create: rawPlatformCreate },
    $extends(extension: unknown): unknown {
      if (typeof extension === 'function') {
        return (extension as (client: unknown) => unknown)(fake);
      }
      const operation = (extension as {
        query: {
          $allModels: {
            $allOperations(args: {
              model: string;
              operation: string;
              args: CapturedOperation;
              query(nextArgs: CapturedOperation): Promise<CapturedOperation>;
            }): Promise<CapturedOperation>;
          };
        };
      }).query.$allModels.$allOperations;
      return {
        invoke: (model: string, operationName: string, args: CapturedOperation = {}) =>
          operation({ model, operation: operationName, args, query }),
      };
    },
  };

  const tenanted = createTenantedClient(fake as never) as unknown as {
    invoke: OperationInvoker;
  };
  return { invoke: tenanted.invoke, query, rawPlatformCreate };
}

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

  it('rejects platform models from the tenant client', async () => {
    expect(TENANT_MODELS.has('PlatformCollectionPolicy')).toBe(false);
    const { invoke, query } = createOperationHarness();

    await expect(
      invoke('PlatformCollectionPolicy', 'create', { data: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps platform model access available on the raw client', async () => {
    const { rawPlatformCreate } = createOperationHarness();

    await expect(rawPlatformCreate({ data: {} })).resolves.toEqual({ data: {} });
    expect(rawPlatformCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown tenant operations by default', async () => {
    const { invoke, query } = createOperationHarness();

    await expect(
      runWithTenant('tenant-a', () => invoke('OutboxEvent', 'futureWrite', { data: {} })),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['$queryRaw', () => tenanted.$queryRaw(Prisma.sql`SELECT 1`)],
    ['$queryRawUnsafe', () => tenanted.$queryRawUnsafe('SELECT 1')],
    ['$executeRaw', () => tenanted.$executeRaw(Prisma.sql`SELECT 1`)],
    ['$executeRawUnsafe', () => tenanted.$executeRawUnsafe('SELECT 1')],
  ])('rejects client-level %s before it reaches the database', async (_operation, invoke) => {
    await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN.code,
    });
  });

  it('overrides spoofed tenantId on create, update, and both upsert branches', async () => {
    const client = createCapturingClient();

    const created = await runWithTenant('tenant-a', () =>
      client.outboxEvent.create({ data: { tenantId: 'tenant-b' } }),
    );
    expect(created.data).toMatchObject({ tenantId: 'tenant-a' });

    const updated = await runWithTenant('tenant-a', () =>
      client.outboxEvent.update({
        where: { id: 'event-a' },
        data: { tenantId: 'tenant-b' },
      }),
    );
    expect(updated.where).toMatchObject({ id: 'event-a', tenantId: 'tenant-a' });
    expect(updated.data).toMatchObject({ tenantId: 'tenant-a' });

    const upserted = await runWithTenant('tenant-a', () =>
      client.outboxEvent.upsert({
        where: { id: 'event-a' },
        create: { tenantId: 'tenant-b' },
        update: { tenantId: 'tenant-b' },
      }),
    );
    expect(upserted.where).toMatchObject({ id: 'event-a', tenantId: 'tenant-a' });
    expect(upserted.create).toMatchObject({ tenantId: 'tenant-a' });
    expect(upserted.update).toMatchObject({ tenantId: 'tenant-a' });
  });
});
