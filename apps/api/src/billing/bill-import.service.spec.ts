import ExcelJS from 'exceljs';
import { BillImportService } from './bill-import.service';

describe('BillImportService 导入解析与校验', () => {
  let audit: { append: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    audit = { append: jest.fn().mockResolvedValue(undefined) };
  });

  const houses = [
    { id: 'house-1', code: 'A1' },
    { id: 'house-2', code: 'A2' },
    { id: 'house-3', code: 'A3' },
  ];

  function makePrisma(overrides: Record<string, unknown> = {}) {
    const tx = {
      billBatch: { create: jest.fn().mockResolvedValue({ id: 'batch-1', status: 'DRAFT' }) },
      bill: {
        create: jest.fn().mockResolvedValue({ id: 'bill-x' }),
        // 导入改为一次 createMany：逐行 create 时 1600 行左右就会撞 Prisma 默认 5s
        // 事务超时并全量回滚，而上传大小限制换算成行数约 3000 行、没有行数上限
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    return {
      tx,
      prisma: {
        raw: {
          house: { findMany: jest.fn().mockResolvedValue(houses) },
          bill: { findMany: jest.fn().mockResolvedValue([]) },
          community: { findFirst: jest.fn().mockResolvedValue({ id: 'community-1' }) },
          billBatch: { findFirst: jest.fn().mockResolvedValue(null) },
          $transaction: jest.fn(
          // 第二个参数是事务选项：导入必须显式设 timeout（默认 5s 在约 1600 行回滚）
          async (cb: (client: typeof tx) => unknown, _opts?: { maxWait?: number; timeout?: number }) => cb(tx),
        ),
        },
        ...overrides,
      },
    };
  }

  function makeService(prisma: unknown): BillImportService {
    return new BillImportService(prisma as never, audit as never);
  }

  const CSV = 'houseCode,amount,title\nA1,100.00,物业费\nA2,50,物业费\n';

  const input = (buffer: Buffer, fileName = 'bills.csv') => ({
    communityId: 'community-1',
    period: '2026-07',
    title: '物业费',
    fileName,
    buffer,
    adminId: 'admin-1',
    actingTenantId: 'tenant-1',
  });

  it('解析 CSV：结构化解析器读取房号/金额/标题', async () => {
    const { prisma } = makePrisma();
    const service = makeService(prisma);
    const rows = await service.parse('bills.csv', Buffer.from(CSV));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ houseCode: 'A1', amount: '100.00', title: '物业费' });
  });

  it('解析 XLSX：exceljs 读取', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('bills');
    ws.addRow(['houseCode', 'amount', 'title']);
    ws.addRow(['A1', 100, '物业费']);
    ws.addRow(['A3', 88.5, '停车费']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const { prisma } = makePrisma();
    const service = makeService(prisma);
    const rows = await service.parse('bills.xlsx', buffer);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.houseCode)).toEqual(['A1', 'A3']);
  });

  it('预览校验：重复行/房屋不存在/金额非法/已缴冲突', async () => {
    const csv = 'houseCode,amount,title\nA1,100,物业费\nA1,100,物业费\nA9,100,物业费\nA2,-5,物业费\nA3,100,物业费\n';
    const { prisma } = makePrisma();
    // A3 本期已缴
    // 查询改为「本期全部非作废账单」后要按 status 区分已缴/未缴，桩数据需带上
    prisma.raw.bill.findMany.mockResolvedValue([
      { houseId: 'house-3', title: '物业费 2026-07', amount: '100.00', status: 'PAID' },
    ]);
    const service = makeService(prisma);
    const preview = await service.preview(input(Buffer.from(csv)));

    const byCode = (code: string, n = 0) => preview.rows.filter((r) => r.houseCode === code)[n];
    expect(byCode('A1', 0).issues.map((i) => i.code)).toContain('DUPLICATE');
    expect(byCode('A9').issues.map((i) => i.code)).toContain('HOUSE_NOT_FOUND');
    expect(byCode('A2').issues.map((i) => i.code)).toContain('INVALID_AMOUNT');
    expect(byCode('A3').issues.map((i) => i.code)).toContain('PAID_CONFLICT');
    expect(preview.summary.total).toBe(5);
    expect(preview.summary.valid).toBe(0);
  });

  it('确认导入：为有效行创建草稿批次与草稿账单，事务内写审计', async () => {
    const { prisma, tx } = makePrisma();
    const service = makeService(prisma);
    const res = await service.confirm(input(Buffer.from(CSV)));
    expect(res).toMatchObject({ batchId: 'batch-1', status: 'DRAFT' });
    expect(res.summary).toMatchObject({ total: 2, valid: 2, totalAmount: '150.00' });
    expect(tx.billBatch.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ source: 'IMPORT', status: 'DRAFT', importFileHash: expect.any(String) }),
    }));
    // 必须是一次批量写，不能逐行
    expect(tx.bill.create).not.toHaveBeenCalled();
    expect(tx.bill.createMany).toHaveBeenCalledTimes(1);
    const args = tx.bill.createMany.mock.calls[0][0];
    // skipDuplicates 承接原来靠捕获 P2002 实现的行键幂等
    // （@@unique([tenantId, batchId, sourceRowKey])）
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(2);
    expect(args.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'DRAFT', source: 'IMPORT', sourceRowKey: 'A1' }),
      ]),
    );
    // 事务必须显式设超时
    const txOpts = prisma.raw.$transaction.mock.calls[0][1] as { timeout?: number } | undefined;
    expect(txOpts?.timeout ?? 0).toBeGreaterThanOrEqual(30_000);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', resourceType: 'BillBatch' }), tx);
  });

  it('文件哈希幂等：同文件重复导入复用同一批次，不再建单', async () => {
    const { prisma, tx } = makePrisma();
    prisma.raw.billBatch.findFirst.mockResolvedValue({
      id: 'batch-existing', status: 'DRAFT', totalRows: 2, validRows: 2, invalidRows: 0, totalAmount: '150.00',
    });
    const service = makeService(prisma);
    const res = await service.confirm(input(Buffer.from(CSV)));
    expect(res.batchId).toBe('batch-existing');
    expect(tx.billBatch.create).not.toHaveBeenCalled();
  });

  it('全部行非法时拒绝导入', async () => {
    const csv = 'houseCode,amount,title\nA9,100,物业费\n';
    const { prisma } = makePrisma();
    const service = makeService(prisma);
    await expect(service.confirm(input(Buffer.from(csv)))).rejects.toMatchObject({ code: 40000 });
  });
});
