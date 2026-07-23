import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

function execSql(sql: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('auth E2E requires DATABASE_URL');
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--stdin', '--url', url], {
    cwd: join(__dirname, '..'), input: sql, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url }, timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`execSql failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`);
}

/** AuditLog 只读（触发器防删）：清理测试租户前临时摘除触发器再重建。 */
function purgeAuditLogs(tenantId: string): void {
  execSql(
    "DROP TRIGGER IF EXISTS `AuditLog_before_delete_append_only`;\n" +
      `DELETE FROM \`AuditLog\` WHERE \`tenantId\` = '${tenantId}';\n` +
      "CREATE TRIGGER `AuditLog_before_delete_append_only` BEFORE DELETE ON `AuditLog` " +
      "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AuditLog is append-only: DELETE is forbidden';",
  );
}

describe('业主认证：微信登录 + 手机号自动绑定', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    // 预置：租户 + 小区 + 一套登记了业主手机号的房
    await prisma.raw.houseBinding.deleteMany({ where: { wxUser: { openid: 'auth-test-openid' } } });
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'auth-test-openid' } });
    const oldTenant = await prisma.raw.tenant.findUnique({ where: { code: 'auth-t' } });
    if (oldTenant) {
      await prisma.raw.houseBinding.deleteMany({ where: { tenantId: oldTenant.id } });
      await prisma.raw.house.deleteMany({ where: { tenantId: oldTenant.id } });
      await prisma.raw.community.deleteMany({ where: { tenantId: oldTenant.id } });
      purgeAuditLogs(oldTenant.id);
      await prisma.raw.tenant.delete({ where: { id: oldTenant.id } });
    }
    const tenant = await prisma.raw.tenant.create({ data: { name: '认证测试物业', code: 'auth-t' } });
    tenantId = tenant.id;
    const community = await prisma.raw.community.create({
      data: { tenantId, name: '认证测试小区' },
    });
    await prisma.raw.house.create({
      data: {
        tenantId,
        communityId: community.id,
        code: '1-1-101',
        displayName: '1 栋 1 单元 101',
        area: 100,
        ownerName: '测试业主',
        ownerPhone: '13900001111',
      },
    });
  });

  afterAll(async () => {
    await prisma.raw.houseBinding.deleteMany({ where: { tenantId } });
    await prisma.raw.house.deleteMany({ where: { tenantId } });
    await prisma.raw.community.deleteMany({ where: { tenantId } });
    purgeAuditLogs(tenantId);
    await prisma.raw.tenant.delete({ where: { id: tenantId } });
    if (userId) await prisma.raw.wxUser.deleteMany({ where: { id: userId } });
    await prisma.raw.wxUser.deleteMany({ where: { openid: 'auth-test-openid' } });
    await app.close();
  });

  let token: string;
  let userId: string;

  it('wx-login：mock code 建号并返回 token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'mock:auth-test-openid' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user.hasPhone).toBe(false);
    token = res.body.data.token;
    userId = res.body.data.user.id;
  });

  it('未带 token 调 /auth/phone 返回 40100', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/phone')
      .send({ code: 'phone:13900001111' })
      .expect(200);
    expect(res.body.code).toBe(40100);
  });

  it('手机号授权后自动匹配绑定房屋', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/phone')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'phone:13900001111' })
      .expect(200);
    expect(res.body.code).toBe(0);
    // 仅返回掩码手机号
    expect(res.body.data.phone).toBe('139****1111');
    expect(res.body.data.matchedHouses).toBe(1);

    const binding = await prisma.raw.houseBinding.findFirst({
      where: { wxUser: { openid: 'auth-test-openid' } },
    });
    expect(binding?.status).toBe('ACTIVE');
    expect(binding?.source).toBe('PHONE_MATCH');
    expect(binding?.tenantId).toBe(tenantId);
    expect(binding?.phoneMatchedAt).toBeTruthy();
  });

  it('重复授权幂等（不重复建绑定）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/phone')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'phone:13900001111' })
      .expect(200);
    expect(res.body.code).toBe(0);
    const count = await prisma.raw.houseBinding.count({
      where: { wxUser: { openid: 'auth-test-openid' } },
    });
    expect(count).toBe(1);
  });

  it('非 mock 前缀 code 在 mock 模式被拒', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/wx-login')
      .send({ code: 'real-code-xyz' })
      .expect(200);
    expect(res.body.code).toBe(40000);
  });

  it('注销账号：匿名化身份、解除绑定、吊销旧令牌，保留可访问的财务/审计留痕', async () => {
    const del = await request(app.getHttpServer())
      .delete('/api/v1/owner/account')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(del.body.code).toBe(0);
    expect(del.body.data.deleted).toBe(true);

    // 身份匿名化：openid 改写、手机号清空、标记注销、tokenVersion 递增
    const user = await prisma.raw.wxUser.findUnique({ where: { id: userId } });
    expect(user?.phone).toBeNull();
    expect(user?.openid).toBe(`deleted:${userId}`);
    expect(user?.deletedAt).toBeTruthy();
    expect(user?.tokenVersion).toBe(1);

    // 活跃绑定被解除
    const active = await prisma.raw.houseBinding.count({ where: { wxUserId: userId, status: 'ACTIVE' } });
    expect(active).toBe(0);

    // 旧令牌被吊销
    const revoked = await request(app.getHttpServer())
      .get('/api/v1/owner/my/houses')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(revoked.body.code).toBe(40100);
  });
});
