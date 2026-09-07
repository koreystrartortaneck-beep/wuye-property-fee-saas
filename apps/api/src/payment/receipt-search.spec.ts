import { AdminPaymentsService } from './admin-payment.controller';

describe('收据手机号与房号搜索', () => {
  it('查询使用租户客户端，覆盖当前联系人、房号和合并付款，不返回联系人手机号', async () => {
    const findMany=jest.fn().mockResolvedValue([]),count=jest.fn().mockResolvedValue(0);
    const service=new AdminPaymentsService({t:{payment:{findMany,count}}} as any);
    await service.list({keyword:'13900001111',houseId:'house-a',channel:'WXPAY',status:'SUCCESS',page:1,pageSize:20} as any);
    const args=findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({channel:'WXPAY',status:'SUCCESS',OR:[{bill:{houseId:'house-a'}},{paymentBills:{some:{bill:{houseId:'house-a'}}}}]});
    const clauses=args.where.AND[0].OR;
    expect(clauses).toContainEqual({receiptNo:{contains:'13900001111'}});
    expect(clauses).toContainEqual({orderNo:{contains:'13900001111'}});
    const house=clauses[2].bill.house;
    expect(house.OR).toContainEqual({code:{contains:'13900001111'}});
    expect(house.OR).toContainEqual({contacts:{some:{OR:[{phone:{contains:'13900001111'}},{name:{contains:'13900001111'}}]}}});
    expect(clauses[3].paymentBills.some.bill.house).toEqual(house);
    expect(count).toHaveBeenCalledWith({where:args.where});
    expect(JSON.stringify(args.select)).not.toMatch(/contacts|ownerPhone/);
    expect(JSON.stringify(args.where)).not.toContain('ownerPhone');
  });
  it('空关键词保持原收款列表查询',async()=>{
    const findMany=jest.fn().mockResolvedValue([]),count=jest.fn().mockResolvedValue(0);
    await new AdminPaymentsService({t:{payment:{findMany,count}}} as any).list({keyword:' ',page:1,pageSize:20} as any);
    expect(findMany.mock.calls[0][0].where).toEqual({});
  });
});
