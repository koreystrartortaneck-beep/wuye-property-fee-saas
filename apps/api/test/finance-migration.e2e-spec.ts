import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

jest.setTimeout(120_000);

const apiRoot = join(__dirname, '..');
const prismaCli = require.resolve('prisma/build/index.js');
const legacyMigrationFiles = [
  join(apiRoot, 'prisma/migrations/20260703024539_init/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260704071459_phase2_tickets_visitors_announcements/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260711035914_phase3_worklog_service_coupon/migration.sql'),
];
const financeMigrationFile = join(
  apiRoot,
  'prisma/migrations/20260722010000_finance_expand/migration.sql',
);

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('finance migration E2E requires DATABASE_URL');
  return value;
}

const baseDatabaseUrl = requireDatabaseUrl();

function databaseUrl(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function runMigration(url: string, file: string) {
  return spawnSync(
    process.execPath,
    [prismaCli, 'db', 'execute', '--file', file, '--url', url],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    },
  );
}

function migrationOutput(result: ReturnType<typeof runMigration>): string {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
}

function applyMigration(url: string, file: string): void {
  const result = runMigration(url, file);
  if (result.status !== 0) {
    throw new Error(`migration failed: ${file}\n${migrationOutput(result)}`);
  }
}

async function withClient<T>(url: string, fn: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    await client.$connect();
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

type ColumnRow = {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: 'YES' | 'NO';
  COLUMN_DEFAULT: string | null;
  NUMERIC_PRECISION: bigint | number | null;
  NUMERIC_SCALE: bigint | number | null;
};

type ForeignKeyRow = {
  CONSTRAINT_NAME: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: bigint | number;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  DELETE_RULE: string;
  UPDATE_RULE: string;
};

type CheckConstraintRow = {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
};

type IndexRow = {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: bigint | number;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: bigint | number;
};

type LegacyBillRow = {
  id: string;
  ruleId: string | null;
  billRunId: string | null;
  batchId: string | null;
  source: string | null;
  sourceRowKey: string | null;
  paymentId: string | null;
};

type LegacyPaymentRow = {
  id: string;
  transactionId: string | null;
  billId: string | null;
  communityId: string | null;
  merchantAccountId: string | null;
  mchid: string | null;
  appid: string | null;
};

type PaymentBillSummaryRow = {
  paymentId: string;
  billCount: bigint | number;
  communities: string;
};

describe('finance_expand legacy upgrade (real MySQL)', () => {
  const createdDatabases = new Set<string>();
  const admin = new PrismaClient({ datasourceUrl: databaseUrl('mysql') });

  async function createLegacyDatabase(label: string): Promise<{ name: string; url: string }> {
    const name = `pf_fin_${label}_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.$executeRawUnsafe(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    createdDatabases.add(name);
    const url = databaseUrl(name);
    for (const file of legacyMigrationFiles) applyMigration(url, file);
    return { name, url };
  }

  async function dropDatabase(name: string): Promise<void> {
    if (!createdDatabases.has(name)) return;
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${name}\``);
    createdDatabases.delete(name);
  }

  async function executeAll(client: PrismaClient, statements: string[]): Promise<void> {
    for (const statement of statements) await client.$executeRawUnsafe(statement);
  }

  async function seedCompatibleLegacyFinance(client: PrismaClient): Promise<void> {
    await executeAll(client, [
      "INSERT INTO `Tenant` (`id`, `name`, `code`) VALUES ('tenant-a', 'Tenant A', 'tenant-a')",
      "INSERT INTO `Community` (`id`, `tenantId`, `name`) VALUES ('community-a1', 'tenant-a', 'Community A1'), ('community-a2', 'tenant-a', 'Community A2')",
      "INSERT INTO `WxUser` (`id`, `openid`) VALUES ('wx-a', 'openid-a')",
      "INSERT INTO `House` (`id`, `tenantId`, `communityId`, `code`, `displayName`) VALUES ('house-a1', 'tenant-a', 'community-a1', 'A1', 'A1'), ('house-a2', 'tenant-a', 'community-a1', 'A2', 'A2'), ('house-a3', 'tenant-a', 'community-a2', 'A3', 'A3')",
      "INSERT INTO `FeeRule` (`id`, `tenantId`, `communityId`, `name`, `ruleType`, `params`) VALUES ('rule-a1', 'tenant-a', 'community-a1', 'Rule A1', 'FIXED', JSON_OBJECT('amount', 100)), ('rule-a2', 'tenant-a', 'community-a2', 'Rule A2', 'FIXED', JSON_OBJECT('amount', 200))",
      "INSERT INTO `BillRun` (`id`, `tenantId`, `ruleId`, `period`) VALUES ('run-a1', 'tenant-a', 'rule-a1', '2026-07'), ('run-a2', 'tenant-a', 'rule-a2', '2026-07')",
      "INSERT INTO `Bill` (`id`, `tenantId`, `communityId`, `houseId`, `ruleId`, `billRunId`, `period`, `title`, `snapshot`, `amount`, `paymentId`, `dueDate`) VALUES ('bill-a1', 'tenant-a', 'community-a1', 'house-a1', 'rule-a1', 'run-a1', '2026-07', 'Bill A1', JSON_OBJECT(), 100.00, NULL, '2026-07-31 00:00:00.000'), ('bill-a2', 'tenant-a', 'community-a1', 'house-a2', 'rule-a1', 'run-a1', '2026-07', 'Bill A2', JSON_OBJECT(), 100.00, 'payment-same', '2026-07-31 00:00:00.000'), ('bill-a3', 'tenant-a', 'community-a2', 'house-a3', 'rule-a2', 'run-a2', '2026-07', 'Bill A3', JSON_OBJECT(), 200.00, 'payment-cross-community', '2026-07-31 00:00:00.000')",
      "INSERT INTO `Payment` (`id`, `tenantId`, `wxUserId`, `orderNo`, `totalAmount`, `channel`, `status`, `transactionId`) VALUES ('payment-same', 'tenant-a', 'wx-a', 'ORDER-SAME', 200.00, 'WXPAY', 'SUCCESS', 'TXN-SAME'), ('payment-cross-community', 'tenant-a', 'wx-a', 'ORDER-CROSS', 300.00, 'WXPAY', 'SUCCESS', 'TXN-CROSS'), ('payment-null-1', 'tenant-a', 'wx-a', 'ORDER-NULL-1', 1.00, 'MOCK', 'CREATED', NULL), ('payment-null-2', 'tenant-a', 'wx-a', 'ORDER-NULL-2', 1.00, 'MOCK', 'CREATED', NULL)",
      "INSERT INTO `PaymentBill` (`paymentId`, `billId`) VALUES ('payment-same', 'bill-a1'), ('payment-same', 'bill-a2'), ('payment-cross-community', 'bill-a1'), ('payment-cross-community', 'bill-a3')",
    ]);
  }

  async function seedValidLegacyTenantGraph(client: PrismaClient): Promise<void> {
    await executeAll(client, [
      "INSERT INTO `Tenant` (`id`, `name`, `code`) VALUES ('tenant-a', 'Tenant A', 'tenant-a'), ('tenant-b', 'Tenant B', 'tenant-b')",
      "INSERT INTO `Community` (`id`, `tenantId`, `name`) VALUES ('community-a', 'tenant-a', 'Community A'), ('community-b', 'tenant-b', 'Community B')",
      "INSERT INTO `WxUser` (`id`, `openid`) VALUES ('wx-a', 'openid-a')",
      "INSERT INTO `House` (`id`, `tenantId`, `communityId`, `code`, `displayName`) VALUES ('house-a', 'tenant-a', 'community-a', 'A1', 'A1'), ('house-b', 'tenant-b', 'community-b', 'B1', 'B1')",
      "INSERT INTO `FeeRule` (`id`, `tenantId`, `communityId`, `name`, `ruleType`, `params`) VALUES ('rule-a', 'tenant-a', 'community-a', 'Rule A', 'FIXED', JSON_OBJECT('amount', 1)), ('rule-b', 'tenant-b', 'community-b', 'Rule B', 'FIXED', JSON_OBJECT('amount', 1))",
      "INSERT INTO `BillRun` (`id`, `tenantId`, `ruleId`, `period`) VALUES ('run-a', 'tenant-a', 'rule-a', '2026-07'), ('run-b', 'tenant-b', 'rule-b', '2026-07')",
      "INSERT INTO `Bill` (`id`, `tenantId`, `communityId`, `houseId`, `ruleId`, `billRunId`, `period`, `title`, `snapshot`, `amount`, `paymentId`, `dueDate`) VALUES ('bill-a', 'tenant-a', 'community-a', 'house-a', 'rule-a', 'run-a', '2026-07', 'Bill A', JSON_OBJECT(), 1.00, 'payment-a', '2026-07-31 00:00:00.000'), ('bill-b', 'tenant-b', 'community-b', 'house-b', 'rule-b', 'run-b', '2026-07', 'Bill B', JSON_OBJECT(), 1.00, 'payment-b', '2026-07-31 00:00:00.000')",
      "INSERT INTO `Payment` (`id`, `tenantId`, `wxUserId`, `orderNo`, `totalAmount`, `transactionId`) VALUES ('payment-a', 'tenant-a', 'wx-a', 'ORDER-A', 1.00, 'TXN-A'), ('payment-b', 'tenant-b', 'wx-a', 'ORDER-B', 1.00, 'TXN-B')",
      "INSERT INTO `PaymentBill` (`paymentId`, `billId`) VALUES ('payment-a', 'bill-a'), ('payment-b', 'bill-b')",
    ]);
  }

  async function expectNoPersistentExpansion(client: PrismaClient): Promise<void> {
    const columns = await client.$queryRawUnsafe<Array<{ TABLE_NAME: string; COLUMN_NAME: string }>>(`
      SELECT TABLE_NAME, COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND (
          (TABLE_NAME = 'FeeRule' AND COLUMN_NAME = 'category')
          OR (TABLE_NAME = 'Bill' AND COLUMN_NAME IN ('batchId', 'source'))
          OR (TABLE_NAME = 'Payment' AND COLUMN_NAME IN ('billId', 'communityId'))
        )
    `);
    const tables = await client.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'BillBatch'
    `);
    const indexes = await client.$queryRawUnsafe<Array<{ INDEX_NAME: string }>>(`
      SELECT INDEX_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'Payment_transactionId_key'
    `);

    expect(columns).toEqual([]);
    expect(tables).toEqual([]);
    expect(indexes).toEqual([]);
  }

  beforeAll(async () => {
    await admin.$connect();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      for (const name of [...createdDatabases]) {
        try {
          await dropDatabase(name);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } finally {
      try {
        await admin.$disconnect();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'failed to clean finance migration test databases');
    }
  });

  it('upgrades b1a5826-era bills and same/cross-community PaymentBill rows without backfill', async () => {
    const database = await createLegacyDatabase('compatible');
    try {
      await withClient(database.url, seedCompatibleLegacyFinance);
      applyMigration(database.url, financeMigrationFile);

      await withClient(database.url, async (client) => {
        const bills = await client.$queryRawUnsafe<LegacyBillRow[]>(`
          SELECT id, ruleId, billRunId, batchId, source, sourceRowKey, paymentId
          FROM Bill
          WHERE id IN ('bill-a1', 'bill-a2', 'bill-a3')
          ORDER BY id
        `);
        expect(bills).toEqual([
          {
            id: 'bill-a1',
            ruleId: 'rule-a1',
            billRunId: 'run-a1',
            batchId: null,
            source: null,
            sourceRowKey: null,
            paymentId: null,
          },
          {
            id: 'bill-a2',
            ruleId: 'rule-a1',
            billRunId: 'run-a1',
            batchId: null,
            source: null,
            sourceRowKey: null,
            paymentId: 'payment-same',
          },
          {
            id: 'bill-a3',
            ruleId: 'rule-a2',
            billRunId: 'run-a2',
            batchId: null,
            source: null,
            sourceRowKey: null,
            paymentId: 'payment-cross-community',
          },
        ]);

        const payments = await client.$queryRawUnsafe<LegacyPaymentRow[]>(`
          SELECT id, transactionId, billId, communityId, merchantAccountId, mchid, appid
          FROM Payment
          WHERE id IN ('payment-same', 'payment-cross-community')
          ORDER BY id
        `);
        expect(payments).toEqual([
          {
            id: 'payment-cross-community',
            transactionId: 'TXN-CROSS',
            billId: null,
            communityId: null,
            merchantAccountId: null,
            mchid: null,
            appid: null,
          },
          {
            id: 'payment-same',
            transactionId: 'TXN-SAME',
            billId: null,
            communityId: null,
            merchantAccountId: null,
            mchid: null,
            appid: null,
          },
        ]);

        const nullTransactionIds = await client.$queryRawUnsafe<Array<{ id: string }>>(`
          SELECT id FROM Payment
          WHERE id IN ('payment-null-1', 'payment-null-2') AND transactionId IS NULL
          ORDER BY id
        `);
        expect(nullTransactionIds).toEqual([{ id: 'payment-null-1' }, { id: 'payment-null-2' }]);

        const summaries = await client.$queryRawUnsafe<PaymentBillSummaryRow[]>(`
          SELECT pb.paymentId, COUNT(*) AS billCount,
                 GROUP_CONCAT(b.communityId ORDER BY b.id SEPARATOR ',') AS communities
          FROM PaymentBill pb
          JOIN Bill b ON b.id = pb.billId
          GROUP BY pb.paymentId
          ORDER BY pb.paymentId
        `);
        expect(
          summaries.map((row) => ({
            paymentId: row.paymentId,
            billCount: Number(row.billCount),
            communities: row.communities,
          })),
        ).toEqual([
          {
            paymentId: 'payment-cross-community',
            billCount: 2,
            communities: 'community-a1,community-a2',
          },
          {
            paymentId: 'payment-same',
            billCount: 2,
            communities: 'community-a1,community-a1',
          },
        ]);

        await executeAll(client, [
          "INSERT INTO `Bill` (`id`, `tenantId`, `communityId`, `houseId`, `ruleId`, `billRunId`, `period`, `title`, `snapshot`, `amount`, `status`, `dueDate`) VALUES ('bill-old-client', 'tenant-a', 'community-a1', 'house-a1', 'rule-a1', 'run-a1', '2026-08', 'Old client bill', JSON_OBJECT(), 100.00, 'UNPAID', '2026-08-31 00:00:00.000')",
          "INSERT INTO `Payment` (`id`, `tenantId`, `wxUserId`, `orderNo`, `totalAmount`, `channel`, `status`, `transactionId`) VALUES ('payment-old-client', 'tenant-a', 'wx-a', 'ORDER-OLD-CLIENT', 100.00, 'MOCK', 'CREATED', 'TXN-OLD-CLIENT')",
          "INSERT INTO `PaymentBill` (`paymentId`, `billId`) VALUES ('payment-old-client', 'bill-old-client')",
        ]);

        const oldClientWrite = await client.$queryRawUnsafe<LegacyPaymentRow[]>(`
          SELECT id, transactionId, billId, communityId, merchantAccountId, mchid, appid
          FROM Payment WHERE id = 'payment-old-client'
        `);
        expect(oldClientWrite).toEqual([
          {
            id: 'payment-old-client',
            transactionId: 'TXN-OLD-CLIENT',
            billId: null,
            communityId: null,
            merchantAccountId: null,
            mchid: null,
            appid: null,
          },
        ]);
      });
    } finally {
      await dropDatabase(database.name);
    }
  });

  it('materializes exact finance constraints, SQL types, and index column order', async () => {
    const database = await createLegacyDatabase('contract');
    try {
      await withClient(database.url, seedCompatibleLegacyFinance);
      applyMigration(database.url, financeMigrationFile);

      await withClient(database.url, async (client) => {
        const foreignKeyRows = await client.$queryRawUnsafe<ForeignKeyRow[]>(`
          SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
                 k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
                 r.DELETE_RULE, r.UPDATE_RULE
          FROM information_schema.KEY_COLUMN_USAGE AS k
          JOIN information_schema.REFERENTIAL_CONSTRAINTS AS r
            ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
           AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION
        `);
        const foreignKeys = new Map<
          string,
          {
            table: string;
            columns: string[];
            referencedTable: string;
            referencedColumns: string[];
            deleteRule: string;
            updateRule: string;
          }
        >();
        for (const row of foreignKeyRows) {
          const value = foreignKeys.get(row.CONSTRAINT_NAME) ?? {
            table: row.TABLE_NAME,
            columns: [],
            referencedTable: row.REFERENCED_TABLE_NAME,
            referencedColumns: [],
            deleteRule: row.DELETE_RULE,
            updateRule: row.UPDATE_RULE,
          };
          value.columns.push(row.COLUMN_NAME);
          value.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
          foreignKeys.set(row.CONSTRAINT_NAME, value);
        }

        const expectedForeignKeys = new Map([
          ['House_tenantId_communityId_fkey', ['House', ['tenantId', 'communityId'], 'Community', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['FeeRule_tenantId_communityId_fkey', ['FeeRule', ['tenantId', 'communityId'], 'Community', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['BillRun_tenantId_ruleId_fkey', ['BillRun', ['tenantId', 'ruleId'], 'FeeRule', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['Bill_tenantId_communityId_fkey', ['Bill', ['tenantId', 'communityId'], 'Community', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['Bill_tenantId_houseId_fkey', ['Bill', ['tenantId', 'houseId'], 'House', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['Bill_tenantId_ruleId_fkey', ['Bill', ['tenantId', 'ruleId'], 'FeeRule', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['Bill_tenantId_billRunId_fkey', ['Bill', ['tenantId', 'billRunId'], 'BillRun', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['Payment_tenantId_billId_fkey', ['Payment', ['tenantId', 'billId'], 'Bill', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['Payment_tenantId_communityId_fkey', ['Payment', ['tenantId', 'communityId'], 'Community', ['tenantId', 'id'], 'RESTRICT', 'CASCADE']],
          ['PaymentBill_paymentId_fkey', ['PaymentBill', ['paymentId'], 'Payment', ['id'], 'RESTRICT', 'CASCADE']],
          ['PaymentBill_billId_fkey', ['PaymentBill', ['billId'], 'Bill', ['id'], 'RESTRICT', 'CASCADE']],
          ['BillBatch_tenantId_ruleId_fkey', ['BillBatch', ['tenantId', 'ruleId'], 'FeeRule', ['tenantId', 'id'], 'RESTRICT', 'RESTRICT']],
        ] as const);
        for (const [
          name,
          [table, columns, referencedTable, referencedColumns, deleteRule, updateRule],
        ] of expectedForeignKeys) {
          expect(foreignKeys.get(name)).toEqual({
            table,
            columns: [...columns],
            referencedTable,
            referencedColumns: [...referencedColumns],
            deleteRule,
            updateRule,
          });
        }

        const columnRows = await client.$queryRawUnsafe<ColumnRow[]>(`
          SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                 NUMERIC_PRECISION, NUMERIC_SCALE
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
        `);
        const columns = new Map(
          columnRows.map((row) => [`${row.TABLE_NAME}.${row.COLUMN_NAME}`, row]),
        );
        for (const key of [
          'Bill.amount',
          'Payment.totalAmount',
          'BillBatch.totalAmount',
          'Refund.originalAmount',
          'Refund.refundAmount',
          'ReconciliationRun.channelAmount',
          'ReconciliationRun.localAmount',
          'ReconciliationRun.differenceAmount',
          'ReconciliationItem.localAmount',
          'ReconciliationItem.channelAmount',
          'ReconciliationItem.differenceAmount',
          'InvoiceApplication.amount',
        ]) {
          expect(Number(columns.get(key)?.NUMERIC_PRECISION)).toBe(12);
          expect(Number(columns.get(key)?.NUMERIC_SCALE)).toBe(2);
        }

        for (const key of [
          'FeeRule.category',
          'Bill.batchId',
          'Bill.source',
          'Payment.billId',
          'Payment.communityId',
        ]) {
          expect(columns.get(key)).toMatchObject({ IS_NULLABLE: 'YES', COLUMN_DEFAULT: null });
        }

        const enumContracts = new Map([
          ['Bill.source', "enum('RULE','IMPORT')"],
          ['Bill.status', "enum('UNPAID','PAID','CANCELED','DRAFT','REFUNDING','REFUNDED')"],
          ['Payment.channel', "enum('MOCK','WXPAY','OFFLINE')"],
          ['Payment.status', "enum('CREATED','SUCCESS','FAILED','CLOSED','REFUNDED','PREPAY_UNKNOWN')"],
          ['Payment.confirmedBy', "enum('WXPAY_NOTIFY','WXPAY_QUERY','OFFLINE','MOCK')"],
          ['BillBatch.source', "enum('RULE','IMPORT')"],
          ['Refund.type', "enum('FULL')"],
          ['Refund.status', "enum('CREATED','PROCESSING','SUCCESS','FAILED','CLOSED','ABNORMAL')"],
        ]);
        for (const [key, columnType] of enumContracts) {
          expect(columns.get(key)?.COLUMN_TYPE).toBe(columnType);
        }

        const indexRows = await client.$queryRawUnsafe<IndexRow[]>(`
          SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
          ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
        `);
        const indexes = new Map<string, { nonUnique: number; columns: string[] }>();
        for (const row of indexRows) {
          const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
          const value = indexes.get(key) ?? {
            nonUnique: Number(row.NON_UNIQUE),
            columns: [],
          };
          value.columns.push(row.COLUMN_NAME);
          indexes.set(key, value);
        }
        expect(indexes.get('Payment.Payment_transactionId_key')).toEqual({
          nonUnique: 0,
          columns: ['transactionId'],
        });
        expect(indexes.get('Payment.Payment_tenantId_id_key')).toEqual({
          nonUnique: 0,
          columns: ['tenantId', 'id'],
        });
        expect(indexes.get('Payment.Payment_channel_status_createdAt_idx')).toEqual({
          nonUnique: 1,
          columns: ['channel', 'status', 'createdAt'],
        });
        expect(indexes.get('Bill.Bill_tenantId_batchId_sourceRowKey_key')).toEqual({
          nonUnique: 0,
          columns: ['tenantId', 'batchId', 'sourceRowKey'],
        });
        expect(indexes.get('Refund.Refund_paymentId_key')).toEqual({
          nonUnique: 0,
          columns: ['paymentId'],
        });
        expect(indexes.has('Refund.Refund_paymentId_status_idx')).toBe(false);

        const checkRows = await client.$queryRawUnsafe<CheckConstraintRow[]>(`
          SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME
          FROM information_schema.TABLE_CONSTRAINTS AS tc
          JOIN information_schema.CHECK_CONSTRAINTS AS cc
            ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
           AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'
          ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME
        `);
        expect(checkRows).toEqual([
          { TABLE_NAME: 'BillBatch', CONSTRAINT_NAME: 'BillBatch_source_fields_chk' },
          {
            TABLE_NAME: 'CommunityCollectionPolicy',
            CONSTRAINT_NAME: 'CommunityCollectionPolicy_pause_reason_chk',
          },
          { TABLE_NAME: 'Payment', CONSTRAINT_NAME: 'Payment_offline_fields_chk' },
          { TABLE_NAME: 'PaymentEvent', CONSTRAINT_NAME: 'PaymentEvent_target_chk' },
          {
            TABLE_NAME: 'PlatformCollectionPolicy',
            CONSTRAINT_NAME: 'PlatformCollectionPolicy_pause_reason_chk',
          },
          { TABLE_NAME: 'Refund', CONSTRAINT_NAME: 'Refund_full_amount_chk' },
          {
            TABLE_NAME: 'TenantCollectionPolicy',
            CONSTRAINT_NAME: 'TenantCollectionPolicy_pause_reason_chk',
          },
        ]);
      });
    } finally {
      await dropDatabase(database.name);
    }
  });

  it('rejects duplicate non-null Payment.transactionId before any persistent expansion DDL', async () => {
    const database = await createLegacyDatabase('duplicate_txn');
    try {
      await withClient(database.url, async (client) => {
        await executeAll(client, [
          "INSERT INTO `Tenant` (`id`, `name`, `code`) VALUES ('tenant-a', 'Tenant A', 'tenant-a')",
          "INSERT INTO `WxUser` (`id`, `openid`) VALUES ('wx-a', 'openid-a')",
          "INSERT INTO `Payment` (`id`, `tenantId`, `wxUserId`, `orderNo`, `totalAmount`, `transactionId`) VALUES ('payment-a1', 'tenant-a', 'wx-a', 'ORDER-A1', 1.00, 'DUPLICATE-TXN'), ('payment-a2', 'tenant-a', 'wx-a', 'ORDER-A2', 1.00, 'DUPLICATE-TXN')",
        ]);
      });

      const result = runMigration(database.url, financeMigrationFile);
      expect(result.status).not.toBe(0);
      expect(migrationOutput(result)).toContain(
        'finance_preflight_payment_transaction_id_unique_chk',
      );
      await withClient(database.url, expectNoPersistentExpansion);
    } finally {
      await dropDatabase(database.name);
    }
  });

  it.each([
    {
      label: 'House -> Community',
      databaseLabel: 'house_community',
      dirtySql: "UPDATE `House` SET `tenantId` = 'tenant-b' WHERE `id` = 'house-a'",
      constraint: 'finance_preflight_house_community_tenant_chk',
    },
    {
      label: 'FeeRule -> Community',
      databaseLabel: 'fee_rule_community',
      dirtySql: "UPDATE `FeeRule` SET `tenantId` = 'tenant-b' WHERE `id` = 'rule-a'",
      constraint: 'finance_preflight_fee_rule_community_tenant_chk',
    },
    {
      label: 'BillRun -> FeeRule',
      databaseLabel: 'bill_run_rule',
      dirtySql: "UPDATE `BillRun` SET `tenantId` = 'tenant-b' WHERE `id` = 'run-a'",
      constraint: 'finance_preflight_bill_run_rule_tenant_chk',
    },
    {
      label: 'Bill -> Community',
      databaseLabel: 'bill_community',
      dirtySql: "UPDATE `Bill` SET `communityId` = 'community-b' WHERE `id` = 'bill-a'",
      constraint: 'finance_preflight_bill_community_tenant_chk',
    },
    {
      label: 'Bill -> House',
      databaseLabel: 'bill_house',
      dirtySql: "UPDATE `Bill` SET `houseId` = 'house-b' WHERE `id` = 'bill-a'",
      constraint: 'finance_preflight_bill_house_tenant_chk',
    },
    {
      label: 'Bill -> FeeRule',
      databaseLabel: 'bill_rule',
      dirtySql: "UPDATE `Bill` SET `ruleId` = 'rule-b' WHERE `id` = 'bill-a'",
      constraint: 'finance_preflight_bill_rule_tenant_chk',
    },
    {
      label: 'Bill -> BillRun',
      databaseLabel: 'bill_bill_run',
      dirtySql: "UPDATE `Bill` SET `billRunId` = 'run-b' WHERE `id` = 'bill-a'",
      constraint: 'finance_preflight_bill_bill_run_tenant_chk',
    },
    {
      label: 'PaymentBill -> Payment/Bill',
      databaseLabel: 'payment_bill',
      dirtySql: "INSERT INTO `PaymentBill` (`paymentId`, `billId`) VALUES ('payment-a', 'bill-b')",
      constraint: 'finance_preflight_payment_bill_tenant_chk',
    },
    {
      label: 'Bill.paymentId -> Payment',
      databaseLabel: 'bill_payment',
      dirtySql: "UPDATE `Bill` SET `paymentId` = 'payment-b' WHERE `id` = 'bill-a'",
      constraint: 'finance_preflight_bill_payment_tenant_chk',
    },
  ])('rejects cross-tenant $label before any persistent expansion DDL', async (testCase) => {
    const database = await createLegacyDatabase(testCase.databaseLabel);
    try {
      await withClient(database.url, async (client) => {
        await seedValidLegacyTenantGraph(client);
        await client.$executeRawUnsafe(testCase.dirtySql);
      });

      const result = runMigration(database.url, financeMigrationFile);
      expect(result.status).not.toBe(0);
      expect(migrationOutput(result)).toContain(testCase.constraint);
      await withClient(database.url, expectNoPersistentExpansion);
    } finally {
      await dropDatabase(database.name);
    }
  });
});
