import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('工单：报修全流程', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let houseId: string;
  let ownerToken: string;
  let adminToken: string;
  let ticketId: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'tkt-w3' } });
    if (t) {
      await prisma.raw.ticket.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.adminUser.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: { in: ['tkt-w3-owner', 'tkt-w3-other'] } } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '工单测试物业', code: 'tkt-w3' } });
    tenantId = tenant.id;
    await prisma.raw.adminUser.create({
      data: { tenantId, username: 'tkt-w3-adm', passwordHash: await bcrypt.hash('p123456', 10), name: 'a', role: 'TENANT_ADMIN' },
    });
    const community = await prisma.raw.community.create({ data: { tenantId, name: '工单测试小区' } });
    const house = await prisma.raw.house.create({
      data: { tenantId, communityId: community.id, code: 't-101', displayName: 't101', area: 100 },
    });
    houseId = house.id;

    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:tkt-w3-owner' });
    ownerToken = wx.body.data.token;
    const user = await prisma.raw.wxUser.findUnique({ where: { openid: 'tkt-w3-owner' } });
    await prisma.raw.houseBinding.create({
      data: { tenantId, wxUserId: user!.id, houseId, status: 'ACTIVE', source: 'PHONE_MATCH' },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'tkt-w3-adm', password: 'p123456' });
    adminToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('业主提交报修（含图片）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/tickets')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ houseId, type: 'REPAIR', content: '厨房水管漏水', images: ['/uploads/202607/a.jpg'] })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('PENDING');
    ticketId = res.body.data.id;
  });

  it('非本人房屋提交被拒 41001', async () => {
    const wx = await request(app.getHttpServer()).post('/api/v1/auth/wx-login').send({ code: 'mock:tkt-w3-other' });
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/tickets')
      .set('Authorization', `Bearer ${wx.body.data.token}`)
      .send({ houseId, type: 'REPAIR', content: 'x', images: [] })
      .expect(200);
    expect(res.body.code).toBe(41001);
  });

  it('未办结不可评价 44001', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/tickets/${ticketId}/rate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ rating: 5 })
      .expect(200);
    expect(res.body.code).toBe(44001);
  });

  it('后台派单 → 办结', async () => {
    const p = await request(app.getHttpServer())
      .post(`/api/v1/admin/tickets/${ticketId}/process`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ assigneeName: '王师傅' })
      .expect(200);
    expect(p.body.data.status).toBe('PROCESSING');

    const d = await request(app.getHttpServer())
      .post(`/api/v1/admin/tickets/${ticketId}/done`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ replyContent: '已更换水管接头' })
      .expect(200);
    expect(d.body.data.status).toBe('DONE');
  });

  it('业主评分，重复评分被拒', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/owner/tickets/${ticketId}/rate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ rating: 5, comment: '响应很快' })
      .expect(200);
    expect(res.body.code).toBe(0);

    const again = await request(app.getHttpServer())
      .post(`/api/v1/owner/tickets/${ticketId}/rate`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ rating: 1 })
      .expect(200);
    expect(again.body.code).toBe(44001);
  });

  it('业主详情含时间线字段与回复', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const t = res.body.data;
    expect(t.assigneeName).toBe('王师傅');
    expect(t.replyContent).toBe('已更换水管接头');
    expect(t.rating).toBe(5);
    expect(t.processedAt).toBeTruthy();
    expect(t.doneAt).toBeTruthy();
  });

  it('后台列表可按状态筛选且带房屋信息', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/tickets?status=DONE')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.list[0].house.code).toBe('t-101');
  });
});
