import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

jest.setTimeout(120_000);

const apiRoot = join(__dirname, '..');
const prismaCli = require.resolve('prisma/build/index.js');
const migrationFiles = [
  join(apiRoot, 'prisma/migrations/20260703024539_init/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260704071459_phase2_tickets_visitors_announcements/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260711035914_phase3_worklog_service_coupon/migration.sql'),
  join(apiRoot, 'prisma/migrations/20260722010000_finance_expand/migration.sql'),
];
const backfillFile = join(apiRoot, 'prisma/migrations/20260722080000_finance_backfill/migration.sql');

const baseDatabaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('finance backfill E2E requires DATABASE_URL');
  return value;
})();

function databaseUrl(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function applyMigration(url: string, file: string): void {
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--file', file, '--url', url], {
    cwd: apiRoot,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`migration failed: ${file}\n${[result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n')}`);
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

describe('finance_backfill legacy backfill (real MySQL)', () => {
  const createdDatabases = new Set<string>();
  const admin = new PrismaClient({ datasourceUrl: databaseUrl('mysql') });

  async function createDatabase(label: string): Promise<{ name: string; url: string }> {
    const name = `pf_bf_${label}_${process.pid}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    createdDatabases.add(name);
    const url = databaseUrl(name);
    for (const file of migrationFiles) applyMigration(url, file);
    return { name, url };
  }

  async function dropDatabase(name: string): Promise<void> {
    if (!createdDatabases.has(name)) return;
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${name}\``);
    createdDatabases.delete(name);
  }

  async function seed(client: PrismaClient): Promise<void> {
    const statements = [
      "INSERT INTO `Tenant` (`id`, `name`, `code`) VALUES ('tenant-a', 'Tenant A', 'tenant-a')",
      "INSERT INTO `Community` (`id`, `tenantId`, `name`) VALUES ('community-a1', 'tenant-a', 'A1'), ('community-a2', 'tenant-a', 'A2')",
      "INSERT INTO `WxUser` (`id`, `openid`) VALUES ('wx-a', 'openid-a')",
      "INSERT INTO `House` (`id`, `tenantId`, `communityId`, `code`, `displayName`) VALUES ('house-a1', 'tenant-a', 'community-a1', 'A1', 'A1'), ('house-a2', 'tenant-a', 'community-a1', 'A2', 'A2'), ('house-a3', 'tenant-a', 'community-a2', 'A3', 'A3')",
      "INSERT INTO `FeeRule` (`id`, `tenantId`, `communityId`, `name`, `ruleType`, `params`, `enabled`) VALUES ('rule-a1', 'tenant-a', 'community-a1', 'Rule A1', 'FIXED', JSON_OBJECT('amount', 100), 1), ('rule-a2', 'tenant-a', 'community-a2', 'Rule A2', 'FIXED', JSON_OBJECT('amount', 200), 1), ('rule-formula', 'tenant-a', 'community-a1', 'Formula', 'FORMULA', JSON_OBJECT('expr', 'area*2'), 1)",
      "INSERT INTO `BillRun` (`id`, `tenantId`, `ruleId`, `period`, `status`, `total`, `generated`, `skipped`) VALUES ('run-a1', 'tenant-a', 'rule-a1', '2026-07', 'DONE', 2, 2, 0), ('run-a2', 'tenant-a', 'rule-a2', '2026-07', 'DONE', 1, 1, 0)",
      "INSERT INTO `Bill` (`id`, `tenantId`, `communityId`, `houseId`, `ruleId`, `billRunId`, `period`, `title`, `snapshot`, `amount`, `status`, `paymentId`, `dueDate`) VALUES ('bill-a1', 'tenant-a', 'community-a1', 'house-a1', 'rule-a1', 'run-a1', '2026-07', 'Bill A1', JSON_OBJECT(), 100.00, 'UNPAID', NULL, '2026-07-31 00:00:00.000'), ('bill-a2', 'tenant-a', 'community-a1', 'house-a2', 'rule-a1', 'run-a1', '2026-07', 'Bill A2', JSON_OBJECT(), 100.00, 'PAID', 'payment-same', '2026-07-31 00:00:00.000'), ('bill-a3', 'tenant-a', 'community-a2', 'house-a3', 'rule-a2', 'run-a2', '2026-07', 'Bill A3', JSON_OBJECT(), 200.00, 'PAID', 'payment-cross', '2026-07-31 00:00:00.000')",
      "INSERT INTO `Payment` (`id`, `tenantId`, `wxUserId`, `orderNo`, `totalAmount`, `channel`, `status`) VALUES ('payment-same', 'tenant-a', 'wx-a', 'ORDER-SAME', 100.00, 'WXPAY', 'SUCCESS'), ('payment-cross', 'tenant-a', 'wx-a', 'ORDER-CROSS', 300.00, 'WXPAY', 'SUCCESS')",
      "INSERT INTO `PaymentBill` (`paymentId`, `billId`) VALUES ('payment-same', 'bill-a2'), ('payment-cross', 'bill-a1'), ('payment-cross', 'bill-a3')",
    ];
    for (const sql of statements) await client.$executeRawUnsafe(sql);
  }

  beforeAll(async () => {
    await admin.$connect();
  });

  afterAll(async () => {
    for (const name of [...createdDatabases]) await dropDatabase(name);
    await admin.$disconnect();
  });

  it('回填批次/账单/小区并可安全重入', async () => {
    const database = await createDatabase('resume');
    try {
      await withClient(database.url, seed);
      // 重入：连续执行两次不应产生重复行或错误。
      applyMigration(database.url, backfillFile);
      applyMigration(database.url, backfillFile);

      await withClient(database.url, async (client) => {
        const formula = await client.$queryRawUnsafe<Array<{ enabled: number }>>(
          "SELECT `enabled` FROM `FeeRule` WHERE `id` = 'rule-formula'",
        );
        expect(Number(formula[0].enabled)).toBe(0);

        const batches = await client.$queryRawUnsafe<Array<{ id: string; source: string; status: string; validRows: number; totalAmount: string }>>(
          "SELECT `id`, `source`, `status`, `validRows`, `totalAmount` FROM `BillBatch` WHERE `id` IN ('batch_run-a1', 'batch_run-a2') ORDER BY `id`",
        );
        expect(batches).toHaveLength(2);
        expect(batches[0]).toMatchObject({ id: 'batch_run-a1', source: 'RULE', status: 'PUBLISHED' });
        expect(Number(batches[0].validRows)).toBe(2);

        const totalBatches = await client.$queryRawUnsafe<Array<{ n: bigint }>>(
          "SELECT COUNT(*) AS n FROM `BillBatch`",
        );
        expect(Number(totalBatches[0].n)).toBe(2); // 重入未重复建批次

        const bills = await client.$queryRawUnsafe<Array<{ id: string; batchId: string | null; source: string | null; publishedAt: Date | null }>>(
          "SELECT `id`, `batchId`, `source`, `publishedAt` FROM `Bill` ORDER BY `id`",
        );
        for (const b of bills) {
          expect(b.source).toBe('RULE');
          expect(b.batchId).not.toBeNull();
          expect(b.publishedAt).not.toBeNull();
        }

        const payments = await client.$queryRawUnsafe<Array<{ id: string; communityId: string | null }>>(
          "SELECT `id`, `communityId` FROM `Payment` ORDER BY `id`",
        );
        const byId = new Map(payments.map((p) => [p.id, p.communityId]));
        expect(byId.get('payment-same')).toBe('community-a1'); // 单一小区回填
        expect(byId.get('payment-cross')).toBeNull(); // 跨小区保持 NULL
      });
    } finally {
      await dropDatabase(database.name);
    }
  });
});
