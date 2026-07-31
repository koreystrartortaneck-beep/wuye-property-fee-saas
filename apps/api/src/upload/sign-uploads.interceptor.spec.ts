import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signUploadsDeep } from './sign-uploads.interceptor';
import { signIfUploadPath, stripUploadSignature, verifyUploadToken } from './upload-access';

/**
 * 这一组守卫针对的缺陷是「逐处调用型防护必然漏一处」。
 *
 * 真实经历：signUploadPaths 在工单列表、工单详情、工作日志列表都调了，
 * 唯独 `GET /owner/work-logs/:id` 漏了 —— 那正是小程序小区动态详情页取图的接口，
 * 于是列表封面正常、点进详情整页裂图。另有 create / rate / process / done / close
 * 五处返回整条记录，全是裸路径。
 *
 * 所以断言的不是「某个文件里有没有调 signUploadPaths」，而是
 * 「出口统一现签这件事本身有没有生效、有没有被绕开」。
 */

const SRC = join(__dirname, '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

const OLD_SECRET = process.env.JWT_SECRET;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-for-sign-uploads';
});
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = OLD_SECRET;
});

/** 取签名后的 pathname / exp / sig，用真校验函数验一遍 */
function assertUsable(signed: string, originalPath: string): void {
  const [pathname, qs] = signed.split('?');
  expect(pathname).toBe(originalPath);
  const params = new URLSearchParams(qs);
  // 用真正的校验函数，而不是自己再拼一遍 HMAC —— 后者会让签名与校验一起错还测不出来
  expect(() => verifyUploadToken(pathname, params.get('exp'), params.get('sig'))).not.toThrow();
}

describe('上传路径在响应出口统一现签', () => {
  it('深层嵌套里的 /uploads 路径也会被签到', () => {
    const body = {
      code: 0,
      data: {
        list: [
          { id: 'a', images: ['/uploads/2026/07/x.jpg', 'cloud://y.jpg'] },
          { id: 'b', nested: { cover: '/uploads/2026/07/z.png' } },
        ],
      },
    };
    const out = signUploadsDeep(body) as typeof body;
    assertUsable(out.data.list[0].images![0], '/uploads/2026/07/x.jpg');
    // cloud:// 与 http 外链必须原样透传，改写它们等于把微信云存储的临时 URL 弄坏
    expect(out.data.list[0].images![1]).toBe('cloud://y.jpg');
    assertUsable((out.data.list[1] as { nested: { cover: string } }).nested.cover, '/uploads/2026/07/z.png');
  });

  it('按字段名白名单会漏，所以任意字段名都要覆盖', () => {
    const out = signUploadsDeep({ avatar: '/uploads/a.jpg', 随便一个名字: '/uploads/b.jpg' }) as Record<string, string>;
    assertUsable(out.avatar, '/uploads/a.jpg');
    assertUsable(out['随便一个名字'], '/uploads/b.jpg');
  });

  it('幂等：已带签名的不会被签第二次', () => {
    const once = signIfUploadPath('/uploads/a.jpg');
    const twice = signUploadsDeep({ u: once }) as { u: string };
    expect(twice.u).toBe(once);
    // 签两次会得到 ...?exp=1&sig=a?exp=2&sig=b，exp 解析成 NaN → 必然 403
    expect(twice.u.match(/sig=/g)).toHaveLength(1);
  });

  it('金额等类实例必须原样返回，不能被展开成普通对象', () => {
    /*
     * 用 Decimal 的真实形状而不是 Date：Date 的自有可枚举键是空的，展开它恰好又得到
     * 原对象，所以拿 Date 断言这条守卫是**空断言** —— 去掉原型检查它照样通过。
     * Prisma 的 Decimal 是 decimal.js 实例，带 s/e/d 三个自有字段，展开后金额会变成
     * `{"s":1,"e":2,"d":[123,4500000]}`，前端拿到的所有金额直接烂掉。这才是真风险。
     */
    class DecimalLike {
      s = 1;
      e = 2;
      d = [123, 4500000];
      toFixed(): string {
        return '123.45';
      }
    }
    const amount = new DecimalLike();
    const created = new Date('2026-07-31T00:00:00.000Z');
    const out = signUploadsDeep({ amount, createdAt: created, nil: null }) as Record<string, unknown>;
    expect(out.amount).toBe(amount);
    expect(typeof (out.amount as DecimalLike).toFixed).toBe('function');
    expect(out.createdAt).toBe(created);
    expect(out.nil).toBeNull();
  });

  it('类实例即使内部含上传路径，也不能被降级成普通对象', () => {
    /*
     * 上一条其实测不到原型检查那一行：不含上传路径时「无改动返回原对象」已经保住了
     * 引用，删掉原型检查它照样通过 —— 这是我第一版犯的错。
     * 原型检查唯一起作用的场景就是这里：实例内部有可签的字符串。
     * 少了它，返回的是 {..., note: 签过的} 普通对象，方法全丢 ——
     * 若这实例是 Decimal，前端拿到的金额就变成一个内部字段的对象。
     */
    class WithPath {
      note = '/uploads/a.jpg';
      label(): string {
        return 'ok';
      }
    }
    const inst = new WithPath();
    const out = signUploadsDeep({ inst }) as { inst: WithPath };
    expect(out.inst).toBe(inst);
    expect(typeof out.inst.label).toBe('function');
    expect(out.inst.note).toBe('/uploads/a.jpg');
  });

  it('类实例里的上传路径不会被漏签（同层有金额也一样）', () => {
    // 上一条要求「类实例原样返回」，容易被过度实现成「见到对象就早退」。
    // 这一条钉住：plain object 该走进去的必须走进去。
    const out = signUploadsDeep({ amount: new Map(), images: ['/uploads/a.jpg'] }) as {
      images: string[];
    };
    assertUsable(out.images[0], '/uploads/a.jpg');
  });

  it('不含上传路径的响应原对象返回，不做无谓复制', () => {
    const body = { data: { list: [{ id: 'a', name: '张三' }] } };
    expect(signUploadsDeep(body)).toBe(body);
  });

  it('自引用结构不会栈溢出', () => {
    const a: Record<string, unknown> = { u: '/uploads/a.jpg' };
    a.self = a;
    expect(() => signUploadsDeep(a)).not.toThrow();
  });
});

describe('拦截器必须真的挂上，且顺序正确', () => {
  const setup = read('setup-app.ts');

  it('SignUploadsInterceptor 全局注册', () => {
    expect(setup).toMatch(/useGlobalInterceptors\([\s\S]*new SignUploadsInterceptor\(\)/);
  });

  it('排在 ResponseInterceptor 之前注册', () => {
    // Nest 全局拦截器按注册顺序进、逆序出，先注册的后处理响应体。
    // 顺序写反只会签到未包装的内层：看起来也有签名，但包装层之外的字段漏掉。
    const call = setup.slice(setup.indexOf('useGlobalInterceptors('));
    const sign = call.indexOf('new SignUploadsInterceptor()');
    const resp = call.indexOf('new ResponseInterceptor()');
    expect(sign).toBeGreaterThanOrEqual(0);
    expect(resp).toBeGreaterThanOrEqual(0);
    expect(sign).toBeLessThan(resp);
  });
});

describe('库里只能存裸路径', () => {
  it('剥签名还原为可入库的路径', () => {
    const signed = signIfUploadPath('/uploads/2026/07/a.jpg');
    expect(stripUploadSignature([signed])).toEqual(['/uploads/2026/07/a.jpg']);
  });

  it('cloud:// 与 http 外链不被剥（它们的 query 是有意义的）', () => {
    // 微信云存储临时 URL 自带鉴权参数，剥掉就下载不了
    const urls = ['cloud://a.jpg', 'https://x.com/a.jpg?sign=abc'];
    expect(stripUploadSignature(urls)).toEqual(urls);
  });

  it('所有接收 images 的写入口都先剥签名', () => {
    /*
     * 出口统一现签之后，客户端手里的地址是带令牌的。若某个编辑流程把它原样提交回来
     * （前端很自然会这么做），入库的就是带令牌的路径 —— 10 分钟后这条记录的图永久
     * 打不开，而且从库里看不出原因。所以写入口必须收窄。
     */
    const writeSites = [
      ['tickets/tickets.service.ts', 'ticket.create'],
      ['work-logs/admin-work-logs.controller.ts', 'workLog.create'],
    ] as const;
    for (const [file, what] of writeSites) {
      const src = read(file);
      expect(src.includes('stripUploadSignature(')).toBe(true);
      // 不能出现「把 dto.images 直接塞进 data」的形状
      expect(src).not.toMatch(/images:\s*(dto|body|input)\.images\s*[,\n]/);
      expect(what.length).toBeGreaterThan(0);
    }
  });

  it('工单创建与工作日志创建都不再用 as never 关掉字段校验', () => {
    // `as never` 会让字段名写错、类型不符都编译通过，直到运行时才炸
    for (const f of ['tickets/tickets.service.ts', 'work-logs/admin-work-logs.controller.ts']) {
      expect(read(f)).not.toMatch(/create\(\{\s*data:[^}]*as never/);
    }
  });
});
