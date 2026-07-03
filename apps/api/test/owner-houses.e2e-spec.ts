import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

describe('业主端：小区查询与绑定申请', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let communityId: string;
  let houseId: string;
  let ownerToken: string;

  const CLEAN = async () => {
    const t = await prisma.raw.tenant.findUnique({ where: { code: 'own-t9' } });
    if (t) {
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: t.id } });
      await prisma.raw.tenant.delete({ where: { id: t.id } });
    }
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'own-t9-user' } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await CLEAN();
    const tenant = await prisma.raw.tenant.create({ data: { name: '业主测试物业', code: 'own-t9' } });
    tenantId = tenant.id;
    const community = await prisma.raw.community.create({
      data: { tenantId, name: '业主测试花园' },
    });
    communityId = community.id;
    const house = await prisma.raw.house.create({
      data: {
        tenantId,
        communityId,
        code: '2-1-201',
        displayName: '2 栋 1 单元 201',
        area: 95,
        building: '2',
        ownerName: '李四',
        ownerPhone: '13633334444',
      },
    });
    houseId = house.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'mock:own-t9-user' });
    ownerToken = login.body.data.token;
  });

  afterAll(async () => {
    await CLEAN();
    await app.close();
  });

  it('按关键字搜索小区（含物业名）', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/owner/communities?keyword=业主测试')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.code).toBe(0);
    const item = res.body.data.find((c: { id: string }) => c.id === communityId);
    expect(item.tenantName).toBe('业主测试物业');
  });

  it('列出小区内房号但不泄漏业主信息', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/owner/communities/${communityId}/houses?keyword=201`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    const item = res.body.data.find((h: { id: string }) => h.id === houseId);
    expect(item.displayName).toBe('2 栋 1 单元 201');
    expect(item.ownerName).toBeUndefined();
    expect(item.ownerPhone).toBeUndefined();
  });

  it('提交绑定申请 → PENDING，此时 my/houses 为空', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/bindings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ houseId, relation: 'FAMILY', applicantName: '李小四' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.status).toBe('PENDING');

    const mine = await request(app.getHttpServer())
      .get('/api/v1/owner/my/houses')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(mine.body.data).toHaveLength(0);
  });

  it('重复申请 → 41002', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/owner/bindings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ houseId, relation: 'FAMILY', applicantName: '李小四' })
      .expect(200);
    expect(res.body.code).toBe(41002);
  });

  it('审核通过后 my/houses 可见', async () => {
    const binding = await prisma.raw.houseBinding.findFirst({
      where: { houseId, wxUser: { openid: 'own-t9-user' } },
    });
    await prisma.raw.houseBinding.update({
      where: { id: binding!.id },
      data: { status: 'ACTIVE' },
    });
    const mine = await request(app.getHttpServer())
      .get('/api/v1/owner/my/houses')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].displayName).toBe('2 栋 1 单元 201');
    expect(mine.body.data[0].communityName).toBe('业主测试花园');
  });
});
