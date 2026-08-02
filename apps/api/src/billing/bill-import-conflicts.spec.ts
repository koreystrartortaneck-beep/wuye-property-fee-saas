import { BillImportService } from './bill-import.service';

/**
 * 导入时的同期冲突判定。
 *
 * 2026-08-02 走新用户全流程时撞到：一张 ¥0.01 的账单缴过又退了，
 * 之后这户这个账期**再也导不进任何账单** —— 提示「该房屋本期已存在已缴账单」。
 *
 * 根子是 PAID_LIKE_STATUSES 里塞了 REFUNDED，而且是阻断级 error。
 * 但退款的意义恰恰是撤销那笔收款：钱已经回到业主手里，这笔费用实质上没缴，
 * 重新出账是完全正常的需求（收错金额、退款重开都会走到这里）。
 *
 * 另一处：「已有待缴账单」把 DRAFT 也算了进去，提示却说
 * 「导入后业主会看到两张、可能重复缴费」—— 草稿业主根本看不到，这句话是错的。
 */

type Bill = { houseId: string; status: string; title: string; amount: string };

function validate(bills: Bill[], rows = [{ rowNo: 2, houseCode: 'H1', amount: '1.00', title: '' }]) {
  const svc = new BillImportService(
    {
      raw: {
        house: { findMany: async () => [{ id: 'h1', code: 'H1' }] },
        bill: { findMany: async () => bills },
      },
    } as never,
    { append: jest.fn() } as never,
  );
  // validateRows 是私有的，按契约直接取
  return (svc as unknown as {
    validateRows(c: string, p: string, r: unknown[], t: string): Promise<Array<{ valid: boolean; issues: Array<{ code: string; severity?: string; message: string }> }>>;
  }).validateRows('c1', '2026-08', rows as never, '默认标题');
}

const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

describe('退款过的账单不该挡住重新出账', () => {
  it('同期只有 REFUNDED → 允许导入，但给出提醒', async () => {
    const [row] = await validate([{ houseId: 'h1', status: 'REFUNDED', title: '物业费', amount: '0.01' }]);
    expect(row.valid).toBe(true);
    expect(codes(row)).toContain('REFUNDED_EXISTS');
    expect(codes(row)).not.toContain('PAID_CONFLICT');
    // 必须是 warn，否则等于没改
    expect(row.issues.find((i) => i.code === 'REFUNDED_EXISTS')?.severity).toBe('warn');
  });

  it('同期有 PAID → 仍然阻断（钱还在我们这儿，再导会收两次）', async () => {
    const [row] = await validate([{ houseId: 'h1', status: 'PAID', title: '物业费', amount: '1' }]);
    expect(row.valid).toBe(false);
    expect(codes(row)).toContain('PAID_CONFLICT');
  });

  it('同期有 REFUNDING → 仍然阻断（退款在路上，结果未定）', async () => {
    const [row] = await validate([{ houseId: 'h1', status: 'REFUNDING', title: '物业费', amount: '1' }]);
    expect(row.valid).toBe(false);
    expect(codes(row)).toContain('PAID_CONFLICT');
  });
});

describe('草稿与已发布的待缴要分开说', () => {
  it('DRAFT 单独一类，且不说「业主会看到两张」', async () => {
    /*
     * 草稿业主看不到。真正的风险在别处：等那批账单被发布时才会变成两张，
     * 而那时没人会想起这次导入 —— 所以提示要说的是这个。
     */
    const [row] = await validate([{ houseId: 'h1', status: 'DRAFT', title: '住宅物业费', amount: '2.5' }]);
    expect(codes(row)).toContain('DRAFT_EXISTS');
    expect(codes(row)).not.toContain('UNPAID_EXISTS');
    const msg = row.issues.find((i) => i.code === 'DRAFT_EXISTS')!.message;
    expect(msg).toContain('草稿业主看不到');
    expect(msg).not.toContain('导入后业主会看到两张');
  });

  it('UNPAID 才说「业主会看到两张」', async () => {
    const [row] = await validate([{ houseId: 'h1', status: 'UNPAID', title: '物业费', amount: '1' }]);
    expect(codes(row)).toContain('UNPAID_EXISTS');
    const msg = row.issues.find((i) => i.code === 'UNPAID_EXISTS')!.message;
    expect(msg).toContain('业主会看到两张');
  });

  it('两者同时存在时各报各的，不合并', async () => {
    const [row] = await validate([
      { houseId: 'h1', status: 'UNPAID', title: '物业费', amount: '1' },
      { houseId: 'h1', status: 'DRAFT', title: '车位费', amount: '2' },
    ]);
    expect(codes(row)).toEqual(expect.arrayContaining(['UNPAID_EXISTS', 'DRAFT_EXISTS']));
    // 都是 warn，不该阻断：同房同期多张账单本来就合法（物业费/水费/车位费各一张）
    expect(row.valid).toBe(true);
  });
});
