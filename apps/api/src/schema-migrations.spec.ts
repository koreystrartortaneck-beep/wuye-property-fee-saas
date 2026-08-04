import fs from 'node:fs';
import path from 'node:path';

/**
 * schema.prisma 里声明的每个 @@index，都必须有一条对应的迁移语句，且索引名要与
 * Prisma 的命名约定一致。
 *
 * 为什么这件事值得一条测试：容器的启动命令是
 *   prisma migrate deploy && node dist/apps/api/src/main.js
 * 一旦 schema 与迁移不匹配，migrate deploy 直接失败，**整个服务起不来**——不是某个
 * 接口报错，是后台和业主端一起打不开。而这种不匹配在本地是发现不了的：
 * `prisma migrate diff` 需要连影子库，而生产库在 VPC 私网里，开发机连不上。
 *
 * Prisma 的约定是 `<Model>_<col1>_<col2>_..._idx`（复合索引按声明顺序拼接）。
 * 手写迁移时把名字拼错，schema 就会被判定为漂移。
 */

const PRISMA_DIR = path.join(__dirname, '..', 'prisma');

function schemaIndexes(): Array<{ model: string; cols: string[]; expected: string }> {
  const src = fs.readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8');
  const out: Array<{ model: string; cols: string[]; expected: string }> = [];
  for (const m of src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const model = m[1];
    for (const idx of m[2].matchAll(/^\s*@@index\(\[([^\]]+)\]\)/gm)) {
      const cols = idx[1].split(',').map((c) => c.trim());
      out.push({ model, cols, expected: `${model}_${cols.join('_')}_idx` });
    }
  }
  return out;
}

function allMigrationSql(): string {
  const dirs = fs
    .readdirSync(PRISMA_DIR + '/migrations', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(PRISMA_DIR, 'migrations', e.name, 'migration.sql'))
    .filter((p) => fs.existsSync(p));
  return dirs.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
}

const indexes = schemaIndexes();
const sql = allMigrationSql();

describe('schema 与迁移一致', () => {
  it('解析到足量的 @@index 与迁移 SQL（正则失效会让后续断言空转）', () => {
    expect(indexes.length).toBeGreaterThan(30);
    expect(sql.length).toBeGreaterThan(1000);
  });

  it('每个 @@index 都能在迁移里找到同名索引', () => {
    /*
     * 索引可能由 CREATE INDEX 单独建，也可能在 CREATE TABLE 里以 INDEX 子句声明，
     * 所以只按名字查而不限定语法形式。
     */
    const missing = indexes.filter((i) => !sql.includes(i.expected));
    if (missing.length) {
      throw new Error(
        '以下 @@index 在迁移里找不到对应语句，容器启动时 prisma migrate deploy 会判定 schema 漂移、服务起不来：\n  ' +
          missing.map((i) => `${i.model}([${i.cols.join(', ')}]) → 期望索引名 ${i.expected}`).join('\n  ') +
          '\n请补一条迁移，索引名严格用 <Model>_<列名按声明顺序下划线连接>_idx。',
      );
    }
    expect(missing).toEqual([]);
  });

  it('迁移里的 CREATE INDEX 都能在 schema 里找到声明（防止只加迁移不改 schema）', () => {
    const declared = new Set(indexes.map((i) => i.expected));
    // 唯一索引与外键索引不在 @@index 里声明，单独排除
    const uniqueNames = new Set<string>();
    const schemaSrc = fs.readFileSync(path.join(PRISMA_DIR, 'schema.prisma'), 'utf8');
    for (const m of schemaSrc.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      for (const u of m[2].matchAll(/^\s*@@unique\(\[([^\]]+)\]\)/gm)) {
        uniqueNames.add(`${m[1]}_${u[1].split(',').map((c) => c.trim()).join('_')}_key`);
      }
    }
    const orphan: string[] = [];
    for (const m of sql.matchAll(/CREATE\s+INDEX\s+`([^`]+)`/gi)) {
      const name = m[1];
      if (declared.has(name) || uniqueNames.has(name)) continue;
      orphan.push(name);
    }
    if (orphan.length) {
      throw new Error(
        '以下索引只存在于迁移、schema.prisma 里没有声明——下次生成迁移时 Prisma 会尝试把它删掉：\n  ' +
          [...new Set(orphan)].join('\n  '),
      );
    }
    expect(orphan).toEqual([]);
  });
});

/**
 * 摘过 AuditLog 的 append-only 触发器的迁移，必须在同一个文件里把它装回来。
 *
 * 背景（2026-08-04）：清测试小区时才发现，删审计记录只能靠迁移 ——
 * AuditLog 上有 BEFORE UPDATE / BEFORE DELETE 两个触发器，而摘触发器是 DDL，
 * Prisma 查询引擎走预处理协议根本执行不了（MySQL 1295）。这反过来是件好事：
 * 「审计不可删」在运行时是硬保证，任何管理员、任何接口都破不了。
 *
 * 但迁移能破。所以这一条钉住：谁在迁移里摘了它，就必须在同一个文件里装回去。
 * 少写一半，生产上的审计表会**静默地**变成可改可删 —— 没有任何报错，
 * 而这正是这套系统里最不能悄悄消失的保证。
 */
test('摘掉审计 append-only 触发器的迁移，必须在同一个文件里把两个都装回来', () => {
  const dir = path.join(PRISMA_DIR, 'migrations');
  const offenders: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    const dropped = [...sql.matchAll(/DROP TRIGGER[^;]*?`(AuditLog_before_\w+_append_only)`/g)].map((m) => m[1]);
    if (dropped.length === 0) continue;
    for (const t of new Set(dropped)) {
      // 装回来的定义必须真的存在（IF EXISTS 的 DROP 也算摘）
      if (!new RegExp(`CREATE TRIGGER\\s+\`${t}\``).test(sql)) {
        offenders.push(`${name}: 摘了 ${t} 没装回来`);
      }
    }
    // 装回的两个都要在,别只顾自己要删的那个
    for (const t of ['AuditLog_before_update_append_only', 'AuditLog_before_delete_append_only']) {
      if (!new RegExp(`CREATE TRIGGER\\s+\`${t}\``).test(sql)) {
        offenders.push(`${name}: 缺 ${t} 的重建`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
