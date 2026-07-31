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
 * RolesGuard 的规则是「没标 @Roles 就放行任何已登录管理员」，而管理端多数写端点
 * 既没有方法级也没有类级注解 —— 靠注解等于默认放行，靠方法才是 fail-closed。
 * 本文件的用例就是围绕这一点写的，并且有一条用例**现场数一遍**，
 * 而不是把当时数出来的数字写死在注释里（那种数字注定会过期）。
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

/**
 * 只读拦截的实现位置决定了它的覆盖面。
 *
 * PLATFORM_READONLY 的写操作拦截写在 RolesGuard 里 —— 只挂 @UseGuards(AdminGuard)
 * 而不挂 RolesGuard 的控制器会**完全绕过**它。全库扫下来曾有一个这样的写端点：
 * admin/upload（往服务器写文件）。这类漏洞不会有任何报错，只能靠静态扫描守住。
 */
describe('只读拦截不得被绕过', () => {
  it('所有带写端点的管理端控制器都挂了 RolesGuard', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const SRC = path.join(__dirname, '..');

    const files: string[] = [];
    (function walk(dir: string) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.controller.ts')) files.push(p);
      }
    })(SRC);
    expect(files.length).toBeGreaterThan(15);

    const offenders: string[] = [];
    for (const file of files) {
      const src = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/@Controller\((.*?)\)([\s\S]{0,400}?)export class (\w+)/g)) {
        const decorators = m[2];
        if (!decorators.includes('AdminGuard')) continue;
        if (decorators.includes('RolesGuard')) continue;
        // 该控制器内有没有写端点
        const start = (m.index as number) + m[0].length;
        const next = src.indexOf('@Controller(', start);
        const body = src.slice(start, next === -1 ? undefined : next);
        const writes = (body.match(/@(Post|Patch|Put|Delete)\(/g) ?? []).length;
        if (writes > 0) {
          offenders.push(`${path.relative(SRC, file)} → ${m[3]}（${m[1].trim()}，${writes} 个写端点）`);
        }
      }
    }
    if (offenders.length) {
      throw new Error(
        '以下控制器有写端点但只挂了 AdminGuard，不挂 RolesGuard —— 只读平台账号的写操作' +
          '拦截实现在 RolesGuard 里，这些端点会被完全绕过：\n  ' +
          offenders.join('\n  ') +
          '\n请改成 @UseGuards(AdminGuard, RolesGuard)。',
      );
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 「无注解的写端点占多数」这个前提必须持续成立，否则本角色的实现方式就该重新考虑。
 *
 * 注释里原先写死了「53 个写端点里有 45 个没注解」。后来我自己加了启停账号与创建平台
 * 账号两个端点，实际变成 55 / 45 —— 数字悄悄过期了，而过期的注释比没有注释更危险：
 * 读的人会拿它当事实。所以改成现场数，让测试自己给出当前值。
 */
describe('「按方法拦截」这个选择的前提', () => {
  it('管理端多数写端点确实没有 @Roles 注解（所以不能靠注解判定）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const SRC = path.join(__dirname, '..');

    const files: string[] = [];
    (function walk(dir: string) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.controller.ts')) files.push(p);
      }
    })(SRC);

    let total = 0;
    let unannotated = 0;
    for (const file of files) {
      const src = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (!src.includes('AdminGuard')) continue;
      for (const m of src.matchAll(/@(Post|Patch|Put|Delete)\(/g)) {
        total += 1;
        const at = m.index as number;
        const before = src.slice(Math.max(0, at - 300), at);
        const cls = src.slice(0, at);
        const clsRoles = cls.includes('@Controller') ? cls.split('@Controller').pop()!.includes('@Roles(') : false;
        if (!before.includes('@Roles(') && !clsRoles) unannotated += 1;
      }
    }

    expect(total).toBeGreaterThan(30);
    /*
     * 只要「无注解」占多数，按方法拦截就是唯一 fail-closed 的做法。
     * 若哪天全部端点都标了注解（比例降到很低），可以重新考虑改为按注解判定 ——
     * 那时这条会失败，提醒人来重新评估，而不是让实现和注释各说各话。
     */
    expect(unannotated / total).toBeGreaterThan(0.5);
  });
});
