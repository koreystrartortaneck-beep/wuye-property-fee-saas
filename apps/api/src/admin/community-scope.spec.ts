import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode } from '@pf/shared';
import { assertCommunityInTenant } from './community-scope';

/**
 * communityId 必须校验归属。
 *
 * 发现方式：接着按覆盖率查，fee-rules.controller.ts 只有 42%。读下来发现 create
 * 直接把请求体里的 communityId 存进库，从不校验它存在 —— 再扫全库，
 * 管理端有 6 个写入口都是这样。
 *
 * prisma.t 保证新行的 tenantId 正确，但**不保证它引用的小区也是本公司的**。
 * 后果全都是「静默什么都没发生」，界面不报错，物业以为配好了：
 *   · 费用规则 → 出账 0 户，反复点「生成」找不出原因
 *   · 房屋批量导入 → 房屋挂到别家小区，本公司列表里永远看不到，而结果显示「成功 N 条」
 *   · 公告 / 卡券 / 生活服务 → 范围指向不存在的小区，业主永远看不到
 *
 * 现实路径不只是手填错：SUPER_ADMIN 可切换租户，
 * 浏览器留着上一个租户的小区列表、切完再提交，就是跨租户引用。
 */


/** 取出「类名像 XxxCreateDto/ImportDto/UpdateDto 且类体内声明了 communityId」的类名 */
function dtoClassesWithCommunityId(code: string): string[] {
  const out: string[] = [];
  const re = /class\s+(\w*(?:Create|Import|Update)\w*Dto)\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        if (depth === 0) {
          if (/\bcommunityId\b/.test(code.slice(open + 1, i))) out.push(m[1]);
          break;
        }
      }
    }
  }
  return out;
}

function makePrisma(found: { id: string } | null) {
  const findFirst = jest.fn(async () => found);
  return { prisma: { t: { community: { findFirst } } } as never, findFirst };
}

describe('小区归属校验', () => {
  it('本公司的小区通过', async () => {
    const { prisma } = makePrisma({ id: 'c1' });
    await expect(assertCommunityInTenant(prisma, 'c1')).resolves.toBeUndefined();
  });

  it('查不到（含跨租户）时拒绝，并说清原因', async () => {
    // prisma.t 会注入租户条件，别家公司的小区在这里自然查不到
    const { prisma } = makePrisma(null);
    await expect(assertCommunityInTenant(prisma, 'c-other')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND.code,
    });
    await expect(assertCommunityInTenant(prisma, 'c-other')).rejects.toMatchObject({
      message: expect.stringContaining('不属于当前物业公司'),
    });
  });

  it('null / undefined / 空串放行——它表示「公司全部小区」', async () => {
    /*
     * 公告、卡券、生活服务都用 null 表示全公司范围。
     * 一并拦掉会把这三个功能直接做没，是比漏校验更严重的回归。
     */
    const { prisma, findFirst } = makePrisma(null);
    await expect(assertCommunityInTenant(prisma, null)).resolves.toBeUndefined();
    await expect(assertCommunityInTenant(prisma, undefined)).resolves.toBeUndefined();
    await expect(assertCommunityInTenant(prisma, '')).resolves.toBeUndefined();
    // 不该为此白查一次数据库
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('用 prisma.t 而不是 prisma.raw', () => {
    // 用 raw 就没有租户条件，跨租户的小区反而查得到——校验等于没做
    const src = readFileSync(join(__dirname, 'community-scope.ts'), 'utf8');
    expect(src).toContain('prisma.t.community.findFirst');
    expect(src).not.toContain('prisma.raw');
  });
});

describe('所有接受 communityId 的管理端写入口都接上了校验', () => {
  const SRC = join(__dirname, '..');

  /** 这些写入口的 communityId 来自请求体，必须校验 */
  const REQUIRED = [
    'billing/fee-rules.controller.ts',
    'announcements/admin-announcements.controller.ts',
    'coupons/admin-coupons.controller.ts',
    'services/admin-services.controller.ts',
    'work-logs/admin-work-logs.controller.ts',
    'admin/houses.controller.ts',
  ];

  it('六个入口逐个确认', () => {
    const missing = REQUIRED.filter(
      (f) => !readFileSync(join(SRC, f), 'utf8').includes('assertCommunityInTenant('),
    );
    expect(missing).toEqual([]);
  });

  it('清单没有漏掉新出现的入口', () => {
    /*
     * 上一条是列举式的，只能证明列进来的那几个干净 —— 本仓已经吃过这个亏
     * （as never 的检查列了两个文件，第 4 个文件里又冒出来一次）。
     * 这一条扫全库：任何 DTO 里带 communityId 且有 create/upsert 的管理端文件，
     * 都必须出现在 REQUIRED 里或已经调了校验。
     */
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.controller.ts') && !e.name.includes('.spec.')) out.push(p);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const raw = readFileSync(file, 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /*
       * 必须按**类体边界**判断，不能用固定长度的窗口。
       * 第一版写的是「class ...Dto 之后 2000 字符内出现 communityId」，
       * 于是 meter.controller.ts 被误报：它的 communityId 在紧随其后的
       * ListReadingsQuery（读查询）里，而 CreateReadingDto 根本没有这个字段。
       * 定长窗口跨过类边界这个坑，本仓在 methodBody 上已经踩过两次。
       */
      const declaresInDto = dtoClassesWithCommunityId(code).length > 0;
      const writes = /\.(create|createMany|upsert)\(/.test(code);
      if (!declaresInDto || !writes) continue;
      if (code.includes('assertCommunityInTenant(')) continue;
      offenders.push(file.slice(SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it('扫描器自身能认出未校验的文件（正向对照）', () => {
    // 否则扫描器写坏时返回空数组，上面那条永真
    const fake = `
class CreateThingDto {
  communityId!: string;
}
class C {
  create(dto: CreateThingDto) {
    return this.prisma.t.thing.create({ data: { communityId: dto.communityId } });
  }
}`;
    expect(dtoClassesWithCommunityId(fake)).toEqual(['CreateThingDto']);
    const writes = /\.(create|createMany|upsert)\(/.test(fake);
    expect(writes && !fake.includes('assertCommunityInTenant(')).toBe(true);

    // 反向：communityId 在紧随其后的查询类里，不算写入口（meter.controller 的真实形状）
    const readOnly = `
class CreateReadingDto {
  houseId!: string;
}
class ListReadingsQuery {
  communityId!: string;
}
class C { create(dto: CreateReadingDto) { return this.prisma.t.r.create({ data: {} }); } }`;
    expect(dtoClassesWithCommunityId(readOnly)).toEqual([]);
  });
});
