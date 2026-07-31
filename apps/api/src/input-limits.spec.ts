import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { GlobalExceptionFilter } from './common/http-exception.filter';

/**
 * 超长输入必须给出能照着改的提示，而不是「服务器内部错误」。
 *
 * 实测（生产）：给小区名称塞 300 个汉字 → 50000；给退款原因塞 300 个汉字 → 50000。
 * 退款那条尤其糟：一次**资金操作**失败却只给「服务器内部错误」，物业完全不知道
 * 为什么，也不知道该怎么办。数据库这些列都是 VARCHAR(191)，Prisma 抛 P2000。
 *
 * 两层防护：
 *   1) DTO 上的 @MaxLength——给用户即时、明确的字段级提示；
 *   2) 全局过滤器把 Prisma P2000/P2002/P2003/P2025 翻成可操作提示——字段近百个，
 *      手工标注必然有遗漏，这一层保证「漏了哪个字段，用户看到的也不是 500」。
 */

const SRC = __dirname;

describe('DTO 长度上限', () => {
  /**
   * 会被写进 VARCHAR(191) 列的自由文本，必须有长度上限。
   * 只列真正入库的字段——ID 类超长只会查不到，不会崩，不在此列。
   */
  const MUST_LIMIT: Array<{ file: string; fields: string[] }> = [
    { file: 'admin/communities.controller.ts', fields: ['name', 'address', 'servicePhone'] },
    { file: 'admin/houses.controller.ts', fields: ['code', 'displayName', 'ownerName', 'ownerPhone'] },
    { file: 'admin/tenants.controller.ts', fields: ['name', 'code', 'contactName', 'contactPhone'] },
    { file: 'admin/bindings.controller.ts', fields: ['rejectReason'] },
    { file: 'payment/admin-refund.controller.ts', fields: ['reason'] },
    { file: 'payment/admin-payment.controller.ts', fields: ['voucherNo', 'payerName', 'remark', 'reason'] },
    { file: 'billing/bill-run.controller.ts', fields: ['reason'] },
    { file: 'billing/fee-rules.controller.ts', fields: ['name'] },
    { file: 'invoice/admin-invoice.controller.ts', fields: ['invoiceNo', 'rejectReason'] },
    { file: 'work-logs/admin-work-logs.controller.ts', fields: ['staffName'] },
    { file: 'tickets/admin-tickets.controller.ts', fields: ['assigneeName'] },
    { file: 'owner/owner-houses.controller.ts', fields: ['applicantName'] },
  ];

  it('入库的自由文本字段都标了 @MaxLength', () => {
    const offenders: string[] = [];
    for (const { file, fields } of MUST_LIMIT) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      for (const field of fields) {
        // 该字段声明之前的一段装饰器里必须出现 @MaxLength
        const re = new RegExp(`((?:\\s*@[\\w.]+\\([^)]*\\)\\s*\\n)+)\\s*${field}[!?]?:\\s*[^;]+;`, 'g');
        const matches = [...src.matchAll(re)];
        if (matches.length === 0) {
          offenders.push(`${file} 找不到字段 ${field}——被改名了？请同步更新本测试`);
          continue;
        }
        for (const m of matches) {
          if (!/@MaxLength\(|@Length\(/.test(m[1])) {
            offenders.push(`${file} 的 ${field} 没有长度上限，超长会以 500 返回`);
          }
        }
      }
    }
    if (offenders.length) {
      throw new Error('以下入库字段缺长度上限：\n  ' + offenders.join('\n  '));
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 上限不得超过对应数据库列的容量，否则标了也白标——照样会走到 P2000。
   *
   * 判据取自 schema：VARCHAR(191) 是 Prisma 对 String 的默认映射，
   * 只有显式标了 @db.Text 的字段才允许更长。
   * （本测试第一版把规则写成「一律 ≤191」，结果把 Ticket.replyContent 与
   *   WorkLog.description 这两个真的是 Text 列的字段误判为超限——是测试太粗，不是代码错。）
   */
  it('上限不超过对应列的容量：非 Text 列一律 ≤191', () => {
    const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
    const textFields = new Set(
      [...schema.matchAll(/^\s*(\w+)\s+\S+.*@db\.Text/gm)].map((m) => m[1]),
    );
    expect(textFields.size).toBeGreaterThan(0);

    const tooBig: string[] = [];
    // 扫全部控制器，不只 MUST_LIMIT 列出的那些
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.controller.ts')) out.push(p);
      }
      return out;
    };
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      // 把 @MaxLength(n) 与紧随其后的字段名配对
      for (const m of src.matchAll(/@MaxLength\((\d+)\)[\s\S]{0,200}?(\w+)[!?]?:\s*[^;]+;/g)) {
        const limit = Number(m[1]);
        const field = m[2];
        if (limit > 191 && !textFields.has(field)) {
          tooBig.push(`${path.relative(SRC, file)} 的 ${field} 限 ${limit}，但该列不是 @db.Text`);
        }
      }
    }
    if (tooBig.length) {
      throw new Error('长度上限超过数据库列容量，超长仍会以 P2000 失败：\n  ' + tooBig.join('\n  '));
    }
    expect(tooBig).toEqual([]);
  });
});

describe('全局过滤器翻译 Prisma 错误', () => {
  function run(error: unknown) {
    const captured: { code?: number; message?: string } = {};
    const res = {
      status: () => res,
      json: (body: { code?: number; message?: string }) => {
        Object.assign(captured, body);
        return res;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: '/x', method: 'POST' }) }),
    };
    new GlobalExceptionFilter().catch(error, host as never);
    return captured;
  }

  function prismaError(code: string, meta?: Record<string, unknown>) {
    return new Prisma.PrismaClientKnownRequestError('boom', {
      code,
      clientVersion: 'test',
      meta,
    });
  }

  it('P2000（字段超长）→ 参数错误 + 指出是哪个字段', () => {
    const r = run(prismaError('P2000', { column_name: 'name' }));
    expect(r.code).toBe(40000);
    expect(r.message).toContain('过长');
    expect(r.message).toContain('name');
  });

  it('P2000 缺字段名时仍给可读提示，不退化成 500', () => {
    const r = run(prismaError('P2000'));
    expect(r.code).toBe(40000);
    expect(r.message).toContain('过长');
  });

  it('P2002（唯一冲突）→ 说明重复，而不是「服务器内部错误」', () => {
    const r = run(prismaError('P2002', { target: ['code'] }));
    expect(r.code).toBe(40000);
    expect(r.message).toContain('已存在');
  });

  it('P2025（记录不存在）→ 404 而不是 500', () => {
    expect(run(prismaError('P2025')).code).toBe(40400);
  });

  it('未识别的 Prisma 错误码仍走 500 兜底，不伪装成参数错误', () => {
    const r = run(prismaError('P9999'));
    expect(r.code).toBe(50000);
  });

  it('非 Prisma 的未知异常仍是 500', () => {
    expect(run(new Error('unexpected')).code).toBe(50000);
  });
});
