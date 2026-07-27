import fs from 'node:fs';
import path from 'node:path';

/**
 * 守护「prisma.t 只能访问租户模型」。
 *
 * 起因：住户档案接口用 prisma.t.paymentBill 查询，而 PaymentBill 是无 tenantId
 * 的关联表、不在 TENANT_MODELS 内，租户扩展直接抛
 * 「无权限访问：租户客户端禁止访问非租户模型」，页面显示「没有找到这个房屋」。
 * 这类错误编译期与单测都发现不了，只有真实请求才暴露，故用静态检查兜住。
 */
const SRC = path.join(__dirname, '..');

/** 从 tenant-extension.ts 解析 TENANT_MODELS 的真实清单 */
function tenantModels(): Set<string> {
  const src = fs.readFileSync(path.join(SRC, 'tenant/tenant-extension.ts'), 'utf8');
  const m = src.match(/TENANT_MODELS[^=]*=\s*(?:new Set\()?\[([\s\S]*?)\]/);
  if (!m) throw new Error('未能从 tenant-extension.ts 解析 TENANT_MODELS');
  const names = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]);
  // Prisma 客户端属性是小驼峰，模型名是大驼峰
  return new Set(names.map((n) => n.charAt(0).toLowerCase() + n.slice(1)));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

describe('prisma.t 只允许访问租户模型', () => {
  const allowed = tenantModels();

  it('TENANT_MODELS 解析成功且包含核心模型', () => {
    expect(allowed.size).toBeGreaterThan(10);
    expect(allowed.has('bill')).toBe(true);
    expect(allowed.has('house')).toBe(true);
  });

  it('全部源码中的 prisma.t.<model> 都在清单内', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/prisma\.t\.([a-zA-Z]+)/g)) {
        const model = m[1];
        // 事务/工具方法不是模型
        if (['$transaction', '$queryRaw', '$executeRaw'].includes(model)) continue;
        if (!allowed.has(model)) {
          offenders.push(`${path.relative(SRC, file)} → prisma.t.${model}`);
        }
      }
    }
    const unique = [...new Set(offenders)];
    if (unique.length > 0) {
      throw new Error(
        '以下位置用 prisma.t 访问了非租户模型，运行时会抛「禁止访问非租户模型」：\n  ' +
          unique.join('\n  ') +
          '\n如确需访问（如无 tenantId 的关联表），请改用 prisma.raw 并在注释中说明安全性如何保证。',
      );
    }
    expect(unique).toEqual([]);
  });
});
