import { Reflector } from '@nestjs/core';
import { ADMIN_ROLES } from '@pf/shared';
import { ROLES_KEY, RolesGuard } from './roles.decorator';

/**
 * 只读平台管理员。
 *
 * 起因：SUPER_ADMIN 是「平台视角 + 全权」的合体 —— RolesGuard 对它无条件放行、
 * 租户隔离扩展对它不设过滤（tenantId 为 null 即看全部），于是日常的平台巡检、
 * 排查业主投诉、给客户演示都只能动用这个全权账号，而它一旦被盗即为全系统沦陷：
 * 能退款、能冲正、能暂停收款、能读全部业主手机号。
 *
 * 关键设计约束：**必须按 HTTP 方法拦截，不能靠 @Roles 注解**。
 * RolesGuard 的规则是「没标 @Roles 就放行任何已登录管理员」，而管理端 53 个写端点里
 * 有 45 个既没有方法级也没有类级注解 —— 靠注解等于默认放行，靠方法才是 fail-closed。
 * 本文件的用例就是围绕这一点写的。
 */
describe('PLATFORM_READONLY 只读平台账号', () => {
  function guard(required?: string[]) {
    const reflector = {
      getAllAndOverride: (key: string) => (key === ROLES_KEY ? required : undefined),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  function ctx(role: string, method: string) {
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ method, current: { adminId: 'a1', tenantId: null, role } }) }),
    } as never;
  }

  it('角色枚举里有这一档', () => {
    expect(ADMIN_ROLES).toContain('PLATFORM_READONLY');
  });

  it('GET 放行', () => {
    expect(guard().canActivate(ctx('PLATFORM_READONLY', 'GET'))).toBe(true);
    expect(guard().canActivate(ctx('PLATFORM_READONLY', 'HEAD'))).toBe(true);
  });

  it('POST/PATCH/PUT/DELETE 一律拒绝，即使端点没有任何 @Roles', () => {
    /*
     * 这是本角色成立的核心：管理端 45 个写端点没有注解，若按注解判定就会全部放行。
     */
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(() => guard().canActivate(ctx('PLATFORM_READONLY', method))).toThrow();
    }
  });

  it('写操作被拒时给出的是权限错误，且文案说得清原因', () => {
    try {
      guard().canActivate(ctx('PLATFORM_READONLY', 'POST'));
      throw new Error('应当抛出');
    } catch (e) {
      expect((e as { code?: number }).code).toBe(40300);
      expect((e as Error).message).toContain('只读');
    }
  });

  it('端点标了 @Roles 也不能让它写（注解不是放行依据）', () => {
    // 即便把它列进允许清单，非 GET 依然拒绝
    expect(() => guard(['PLATFORM_READONLY']).canActivate(ctx('PLATFORM_READONLY', 'POST'))).toThrow();
  });

  it('拿不到方法名时按拒绝处理（fail-closed）', () => {
    const c = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ current: { role: 'PLATFORM_READONLY' } }) }),
    } as never;
    expect(() => guard().canActivate(c)).toThrow();
  });

  it('不影响其它角色：超管仍恒通过、租户管理员按注解判定', () => {
    expect(guard(['TENANT_ADMIN']).canActivate(ctx('SUPER_ADMIN', 'POST'))).toBe(true);
    expect(guard(['TENANT_ADMIN']).canActivate(ctx('TENANT_ADMIN', 'POST'))).toBe(true);
    expect(() => guard(['TENANT_ADMIN']).canActivate(ctx('STAFF', 'POST'))).toThrow();
    // 无注解的端点对普通角色仍是放行（原有语义未变）
    expect(guard().canActivate(ctx('STAFF', 'POST'))).toBe(true);
  });

  it('资金出账端点对它同样不可用（这类端点有 @Roles，双重拦截）', () => {
    expect(() => guard(['TENANT_ADMIN']).canActivate(ctx('PLATFORM_READONLY', 'POST'))).toThrow();
  });
});

describe('平台视角的读范围', () => {
  it('AdminGuard 让只读角色与超管一样可跨租户读', () => {
    /*
     * 只读角色的用途正是「平台侧看数据」，读范围不该比超管窄；
     * 写操作已由 RolesGuard 按方法一律拒绝，所以给它平台视角是安全的。
     */
    const src = require('node:fs')
      .readFileSync(require('node:path').join(__dirname, 'admin.guard.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/payload\.role === 'SUPER_ADMIN' \|\| payload\.role === 'PLATFORM_READONLY'/);
  });
});
