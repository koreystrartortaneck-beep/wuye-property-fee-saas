import * as fs from 'node:fs';
import * as path from 'node:path';
import { PERIOD_SCHEMES, AMOUNT_ROUNDINGS } from '@pf/shared';
import { TENANT_MODELS } from '../tenant/tenant-extension';

/**
 * P1 守卫:收费标准目录 / 房屋联系人 / 绑定渠道配置 的 schema 地基。
 *
 * 这一期的约定是「零行为变化」—— 三张新表、若干新列,任何现有路径都不读它们。
 * 但地基有几处一错就静默炸的形状,值得在动第一行业务代码之前钉住:
 *
 *   · 新模型漏注册 TENANT_MODELS → prisma.t 访问一律 FORBIDDEN,
 *     而且报错发生在运行时第一次访问,编译/启动都看不出来
 *   · 枚举回填用 ENUM 直接赋 ENUM → MySQL 可能按索引数字解释
 *   · 回填不幂等 → 迁移重跑(容器重启重放)时撞唯一键,服务起不来
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
const MIG_DIR = path.join(ROOT, 'prisma/migrations');
const readMig = (name: string) =>
  fs.readFileSync(path.join(MIG_DIR, name, 'migration.sql'), 'utf8');

describe('新模型注册进租户隔离', () => {
  it.each(['HouseContact', 'HouseStandard', 'TenantBindingConfig'])('%s 在 TENANT_MODELS 里', (m) => {
    /*
     * 漏了的后果:该模型经 prisma.t 的一切访问抛 FORBIDDEN。
     * 探索时确认这是唯一的注册点(tenant-extension.ts),没有兜底。
     */
    expect(TENANT_MODELS.has(m)).toBe(true);
  });
});

describe('shared 枚举与 Prisma 枚举一致', () => {
  /** 从 schema.prisma 文本抽枚举值(与 finance-schema.spec 同思路:contract 直接对源码) */
  function prismaEnum(name: string): string[] {
    const m = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(SCHEMA);
    if (!m) throw new Error(`schema 里没有枚举 ${name}`);
    return m[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'));
  }

  it('PeriodScheme', () => {
    expect(prismaEnum('PeriodScheme')).toEqual([...PERIOD_SCHEMES]);
  });

  it('AmountRounding', () => {
    expect(prismaEnum('AmountRounding')).toEqual([...AMOUNT_ROUNDINGS]);
  });

  it('PeriodScheme 的前三个值必须与 RulePeriod 完全一致——回填按字符串对拷', () => {
    expect(prismaEnum('PeriodScheme').slice(0, 3)).toEqual(prismaEnum('RulePeriod'));
  });
});

describe('迁移 SQL 的危险形状', () => {
  it('M1 的枚举回填必须 CAST 成字符串,不能 ENUM 直接赋 ENUM', () => {
    /*
     * `SET periodScheme = period` 在 MySQL 里可能按枚举**索引数字**解释。
     * 这里两个枚举前三个值顺序恰好相同、错也错不出来 ——
     * 但正确性不能靠巧合,尤其将来往 PeriodScheme 中间插值时会当场炸。
     */
    const sql = readMig('20260802210000_fee_standard_catalog');
    expect(sql).toMatch(/SET `periodScheme` = CAST\(`period` AS CHAR\)/);
    expect(sql).not.toMatch(/SET `periodScheme` = `period`/);
  });

  it('M2 的联系人回填幂等——确定性 id + NOT EXISTS 双保险', () => {
    /*
     * 迁移可能被重放(部署重试、影子库校验)。
     * 回填不幂等 → 第二次撞 (houseId, phone) 唯一键 → migrate deploy 失败 → 容器起不来,
     * 而失败原因只在容器日志里(见 docs/部署顺序与验证.md)。
     */
    const sql = readMig('20260802210100_house_contacts');
    expect(sql).toMatch(/CONCAT\('hc_', h\.`id`\)/);
    expect(sql).toMatch(/NOT EXISTS/);
    // 空串手机号不该变成联系人
    expect(sql).toMatch(/`ownerPhone` IS NOT NULL AND h\.`ownerPhone` <> ''/);
  });

  it('三个迁移都是纯增量——不许出现 DROP/MODIFY 已有列', () => {
    /*
     * P1 的承诺是在线安全、可独立部署。任何 DROP COLUMN / 改既有列类型
     * 都破坏这个承诺(ownerPhone 的物理删除属于以后的独立迁移)。
     */
    for (const name of [
      '20260802210000_fee_standard_catalog',
      '20260802210100_house_contacts',
      '20260802210200_binding_config',
    ]) {
      const sql = readMig(name).replace(/--.*$/gm, '');
      expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
      // MODIFY 只允许出现在 ENUM 追加这种模式里;这三个迁移里一处都不该有
      expect(sql).not.toMatch(/\bMODIFY\b/i);
    }
  });

  it('新表的外键都带 tenantId 复合键——跨租户挂接在库层就不可能', () => {
    const m1 = readMig('20260802210000_fee_standard_catalog');
    expect(m1).toMatch(/FOREIGN KEY \(`tenantId`, `houseId`\) REFERENCES `House`\(`tenantId`, `id`\)/);
    expect(m1).toMatch(/FOREIGN KEY \(`tenantId`, `ruleId`\) REFERENCES `FeeRule`\(`tenantId`, `id`\)/);
    const m2 = readMig('20260802210100_house_contacts');
    expect(m2).toMatch(/FOREIGN KEY \(`tenantId`, `houseId`\) REFERENCES `House`\(`tenantId`, `id`\)/);
  });
});

describe('挂接与联系人的唯一性', () => {
  it('schema 里钉住核心唯一键', () => {
    // 一房一标准一行;一房一号一行 —— 重复挂接/重复登记在库层挡住
    expect(SCHEMA).toMatch(/model HouseStandard[\s\S]*?@@unique\(\[houseId, ruleId\]\)/);
    expect(SCHEMA).toMatch(/model HouseContact[\s\S]*?@@unique\(\[houseId, phone\]\)/);
    // 标准代号按小区唯一(NULL 除外),复制目录按它去重
    expect(SCHEMA).toMatch(/model FeeRule[\s\S]*?@@unique\(\[communityId, code\]\)/);
    // 一租户一份渠道配置
    expect(SCHEMA).toMatch(/model TenantBindingConfig[\s\S]*?tenantId\s+String\s+@unique/);
  });
});
