import { BillsAdminService } from './bill-run.controller';

describe('BillsAdminService.cancel', () => {
  it('仅原子作废未被支付预占的 UNPAID 账单', async () => {
    const prisma = {
      t: {
        bill: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue({ id: 'bill-1', status: 'UNPAID', paymentId: 'payment-1' }),
        },
      },
    };
    const service = new BillsAdminService(prisma as never);

    await expect(service.cancel('bill-1')).rejects.toThrow('账单正在支付中');
    expect(prisma.t.bill.updateMany).toHaveBeenCalledWith({
      where: { id: 'bill-1', status: 'UNPAID', paymentId: null },
      data: { status: 'CANCELED' },
    });
  });
});
