import { ValidationPipe, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminPaymentController, AdminPaymentsService } from './admin-payment.controller';
import { PaymentService } from './payment.service';
import { OfflinePaymentService } from './offline-payment.service';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';

// 真正经过 Nest 路由和现有 AdminGuard/RolesGuard；认证存储与业务服务用模拟依赖。
// 不连接数据库，也不向微信发起支付/退款请求。
describe('收据发布候选 HTTP 门禁', () => {
  let app: INestApplication;
  const detail=jest.fn().mockResolvedValue({orderNo:'TEST-ORDER',receipt:{receiptNo:'TEST-RECEIPT'}});
  const list=jest.fn().mockResolvedValue({list:[],total:0});
  const offline={settleOffline:jest.fn(),reverseOffline:jest.fn()};
  beforeAll(async()=>{
    const moduleRef=await Test.createTestingModule({
      controllers:[AdminPaymentController],
      providers:[
        {provide:PaymentService,useValue:{getAdminReceipt:detail}},
        {provide:AdminPaymentsService,useValue:{list}},
        {provide:OfflinePaymentService,useValue:offline},
        {provide:AuthService,useValue:{verifyToken:async(token:string)=>({typ:token==='owner'?'owner':'admin',sub:'staff',tenantId:'tenant-a',role:'STAFF',ver:1})}},
        {provide:PrismaService,useValue:{raw:{adminUser:{findUnique:async()=>({status:'ACTIVE',tokenVersion:1,mustChangePassword:false})}}}},
      ],
    }).compile();
    app=moduleRef.createNestApplication({logger:false});
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));
    // 只将业务异常转成可断言响应；不以修改守卫来绕过认证。
    app.useGlobalFilters({catch:(e:any,host:any)=>host.switchToHttp().getResponse().status(e.code===40100?401:e.getStatus?e.getStatus():500).json({code:e.code||0})});
    // 整个测试集复用一个回环监听端口，避免每次请求开关临时端口。
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async()=>{await app.close();});
  beforeEach(()=>jest.clearAllMocks());
  it('未登录不能读取收据',async()=>{
    await request(app.getHttpServer()).get('/api/v1/admin/payments/TEST-ORDER/receipt').expect(401);
    expect(detail).not.toHaveBeenCalled();
  });
  it('业主令牌不能读取管理端收据',async()=>{
    await request(app.getHttpServer()).get('/api/v1/admin/payments/TEST-ORDER/receipt').set('Authorization','Bearer owner').expect(401);
    expect(detail).not.toHaveBeenCalled();
  });
  it('员工读取时租户来自认证，不接受请求伪造租户',async()=>{
    await request(app.getHttpServer()).get('/api/v1/admin/payments/TEST-ORDER/receipt?tenantId=tenant-b').set('Authorization','Bearer staff').set('X-Tenant-Id','tenant-b').expect(200);
    expect(detail).toHaveBeenCalledWith('tenant-a','TEST-ORDER');
    expect(offline.settleOffline).not.toHaveBeenCalled();
  });
  it('搜索路由保留手机号和分页参数',async()=>{
    await request(app.getHttpServer()).get('/api/v1/admin/payments/receipt-search').query({keyword:'13900001111',page:2,pageSize:20,channel:'WXPAY'}).set('Authorization','Bearer staff').expect(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({keyword:'13900001111',page:2,pageSize:20,channel:'WXPAY'}));
  });
  it('超长关键词被拒绝',async()=>{
    await request(app.getHttpServer()).get('/api/v1/admin/payments/receipt-search').query({keyword:'a'.repeat(101)}).set('Authorization','Bearer staff').expect(400);
    expect(list).not.toHaveBeenCalled();
  });
});
