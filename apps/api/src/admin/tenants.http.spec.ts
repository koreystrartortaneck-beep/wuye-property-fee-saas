import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { TenantsController, TenantsService } from './tenants.controller';

/**
 * HTTP 级回归：确认这几个端点**真的注册上了**。
 *
 * 起因：新加 PATCH /admin/tenants/:tenantId/admins/:adminId/status 之后，线上打它
 * 一直返回 40400「资源不存在」。而 40400 同时是「端点不存在」与「账号不存在」的返回值，
 * 两者无法区分 —— 我用不存在的 ID 探测「端点是否已上线」，得到 40400 就以为端点已在，
 * 实际那是路由未命中。反复戳线上十几分钟也判断不出来。
 *
 * 单测直接 new Controller().method() 完全绕过路由注册与参数绑定，所以这一类问题
 * 此前没有任何测试能发现。这个文件走真实 Nest app + supertest，覆盖：
 *   · 路由确实注册（不是 404）
 *   · 路径参数绑定正确（:tenantId / :adminId 各自取到）
 *   · 具体路径排在 @Patch(':id') 之前（否则会被通用路由吃掉）
 */
describe('租户管理端点的路由注册', () => {
  const svc = {
    setAdminStatus: jest.fn().mockResolvedValue({ username: 'u', status: 'DISABLED' }),
    resetAdminPassword: jest.fn().mockResolvedValue({ username: 'u', password: 'p' }),
    createPlatformReadonly: jest.fn().mockResolvedValue({ username: 'ro', password: 'p' }),
    update: jest.fn().mockResolvedValue({ id: 't1' }),
    create: jest.fn(),
    list: jest.fn().mockResolvedValue({ list: [], total: 0 }),
  };

  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TenantsController],
      providers: [{ provide: TenantsService, useValue: svc }],
    })
      // 守卫在这里不是被测对象：注入 current 后一律放行，专测路由与参数绑定
      .overrideGuard(AdminGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp(): { getRequest(): Record<string, unknown> } }) => {
          ctx.switchToHttp().getRequest().current = { adminId: 'super-1', tenantId: null, role: 'SUPER_ADMIN' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    /*
     * 必须装上与生产同样的 ValidationPipe。
     * 不装的话 DTO 上的 @IsIn 等校验完全不生效，「非法 status 被放过」这条用例会失败
     * ——而那恰恰说明测试环境与生产不一致，不是代码有问题。
     * 生产的装配在 setup-app.ts：new ValidationPipe({ whitelist: true, transform: true })。
     */
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('PATCH /admin/tenants/:tenantId/admins/:adminId/status 已注册，且两个路径参数各自取到', async () => {
    const res = await request(app.getHttpServer())
      .patch('/admin/tenants/T-1/admins/A-1/status')
      .send({ status: 'DISABLED' });

    // 404 = 路由没注册上（这正是线上遇到的情况，而 40400 与它无法区分）
    expect(res.status).not.toBe(404);
    expect(svc.setAdminStatus).toHaveBeenCalledWith('T-1', 'A-1', 'DISABLED', 'super-1');
  });

  it('status 只接受 ACTIVE / DISABLED', async () => {
    const res = await request(app.getHttpServer())
      .patch('/admin/tenants/T-1/admins/A-1/status')
      .send({ status: 'WHATEVER' });
    expect(res.status).not.toBe(404);
    expect(svc.setAdminStatus).not.toHaveBeenCalled();
  });

  /*
   * 原本这里有一条「具体路径必须排在 @Patch(':id') 之前」的用例，已删除：
   * 实测把新路由挪到 :id 之后，7 条用例照样全绿 —— Nest/Express 的路由匹配按路径段数
   * 与具体度决定，不受装饰器声明顺序影响。那条断言基于错误前提，恒为真，
   * 留着只会让人误以为「顺序被守住了」。
   *
   * 下面两条用「两个路由互不抢占」来覆盖真正要保证的东西，且它们不依赖声明顺序。
   */
  it('带 /admins/:adminId/status 的请求进 setAdminStatus，不进通用 update', async () => {
    await request(app.getHttpServer()).patch('/admin/tenants/T-1/admins/A-1/status').send({ status: 'ACTIVE' });
    expect(svc.setAdminStatus).toHaveBeenCalledTimes(1);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('PATCH /admin/tenants/:id 仍然可用（没被新路由抢走）', async () => {
    const res = await request(app.getHttpServer()).patch('/admin/tenants/T-1').send({ status: 'DISABLED' });
    expect(res.status).not.toBe(404);
    expect(svc.update).toHaveBeenCalledTimes(1);
    expect(svc.setAdminStatus).not.toHaveBeenCalled();
  });

  it('POST /admin/tenants/platform-readonly 已注册，且不被 :tenantId 通用路由吃掉', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/tenants/platform-readonly')
      // username 有 @MinLength(4)：'ro' 会被 ValidationPipe 拒掉。
      // 这里用合规值测「路由是否注册」，长度规则另有一条用例专测。
      .send({ username: 'readonly', name: '平台只读' });
    expect(res.status).not.toBe(404);
    expect(svc.createPlatformReadonly).toHaveBeenCalledWith('readonly', '平台只读', 'super-1');
  });

  it('平台账号名过短被拒（@MinLength(4)）', async () => {
    await request(app.getHttpServer())
      .post('/admin/tenants/platform-readonly')
      .send({ username: 'ro', name: '平台只读' });
    expect(svc.createPlatformReadonly).not.toHaveBeenCalled();
  });

  it('POST /admin/tenants/:tenantId/admins/:adminId/reset-password 已注册', async () => {
    const res = await request(app.getHttpServer()).post('/admin/tenants/T-1/admins/A-1/reset-password');
    expect(res.status).not.toBe(404);
    expect(svc.resetAdminPassword).toHaveBeenCalledWith('T-1', 'A-1', 'super-1');
  });
});
