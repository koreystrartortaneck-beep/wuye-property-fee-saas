import { PaymentService } from './payment.service';

describe('管理端收据读取', () => {
  const snapshot={receiptNo:'RCPT-O1',orderNo:'O1',totalAmount:'302.00',house:'G-027',community:'金港城',bills:[{title:'车库物业费',amount:'302.00'}]};
  function setup(status='SUCCESS',receipt:unknown=snapshot){
    const findUnique=jest.fn().mockResolvedValue({orderNo:'O1',tenantId:'tenant-a',wxUserId:'owner-a',totalAmount:'302.00',status,receiptNo:'RCPT-O1',receiptSnapshot:receipt,paymentBills:[]});
    const service=Object.create(PaymentService.prototype) as PaymentService;
    Object.assign(service,{prisma:{raw:{payment:{findUnique}}}});
    return {service,findUnique};
  }
  it('租户条件进入查询，管理端和业主端返回同一不可变快照',async()=>{
    const {service,findUnique}=setup();const admin=await service.getAdminReceipt('tenant-a','O1');
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({where:{orderNo:'O1',tenantId:'tenant-a'}}));
    const owner=await service.getPayment('owner-a','O1');expect(admin.receipt).toEqual(owner.receipt);expect(admin.receipt).toBe(snapshot);
    expect(admin).not.toHaveProperty('wxUserId');
  });
  it('跨租户不可读取',async()=>{const {service,findUnique}=setup();findUnique.mockResolvedValue(null);await expect(service.getAdminReceipt('tenant-b','O1')).rejects.toThrow();expect(findUnique.mock.calls[0][0].where.tenantId).toBe('tenant-b');});
  it('退款后保留原始收据并标记作废',async()=>{const {service}=setup('REFUNDED');expect(await service.getAdminReceipt('tenant-a','O1')).toMatchObject({receipt:snapshot,receiptVoid:true});});
  it('尚未入账不生成收据',async()=>{const {service}=setup('CREATED',null);expect((await service.getAdminReceipt('tenant-a','O1')).receipt).toBeNull();});
});
