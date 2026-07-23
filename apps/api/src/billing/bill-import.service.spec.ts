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
      bill: { create: jest.fn().mockResolvedValue({ id: 'bill-x' }) },
    };
    return {
      tx,
      prisma: {
        raw: {
          house: { findMany: jest.fn().mockResolvedValue(houses) },
          bill: { findMany: jest.fn().mockResolvedValue([]) },
          community: { findFirst: jest.fn().mockResolvedValue({ id: 'community-1' }) },
          billBatch: { findFirst: jest.fn().mockResolvedValue(null) },
          $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
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
    prisma.raw.bill.findMany.mockResolvedValue([{ houseId: 'house-3' }]);
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
    expect(tx.bill.create).toHaveBeenCalledTimes(2);
    expect(tx.bill.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'DRAFT', source: 'IMPORT', sourceRowKey: 'A1' }),
    }));
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
