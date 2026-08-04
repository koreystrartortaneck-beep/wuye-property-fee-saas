import { SchemaVersionService } from './schema-version.service';

/**
 * 迁移状态是「部署是否生效」的主要证据 —— 本仓每次推送后都靠它核对
 * （推 GitHub 后云托管自动构建 6~10 分钟且没有回执）。
 * 所以它自己必须不会说谎。
 *
 * 原实现有一个假保证：读不到镜像里的迁移目录时返回空数组，于是 pending 也是空，
 * ok 就成了 true，detail 还是「已应用至 X，共 N 个」——
 * 而此时它对「镜像里应该有哪些迁移」一无所知，那句话没有任何依据。
 * 一个在自己瞎了的时候仍然说「一切正常」的检查，比没有这个检查更糟。
 */
type Row = { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null };

const BOTH_TRIGGERS = ['AuditLog_before_update_append_only', 'AuditLog_before_delete_append_only'];

function makeService(
  rows: Row[] | Error,
  inImage: string[],
  triggers: string[] = BOTH_TRIGGERS,
  /** 行为探测:'ON' 触发器拦下,'OFF' 改到了,'EMPTY' 审计表是空的 */
  probe: 'ON' | 'OFF' | 'EMPTY' = 'ON',
) {
  const prisma = {
    raw: {
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({
          $executeRawUnsafe: jest.fn(async () => {
            if (probe === 'ON') throw new Error("AuditLog is append-only: UPDATE is forbidden");
            return probe === 'EMPTY' ? 0 : 1;
          }),
        }),
      ),
      // 按 SQL 分派:同一个方法既查迁移表也查触发器,一律返回迁移行会让触发器判定失真
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.includes('information_schema.TRIGGERS')) {
          return triggers.map((name) => ({ name }));
        }
        if (rows instanceof Error) throw rows;
        return rows;
      }),
    },
  };
  const svc = new SchemaVersionService(prisma as never);
  // migrationsInImage 是私有的：这里替换掉，避免测试依赖真实文件系统
  (svc as unknown as { migrationsInImage: () => string[] }).migrationsInImage = () => inImage;
  return svc;
}

const done = (n: string): Row => ({ migration_name: n, finished_at: new Date(), rolled_back_at: null });
const unfinished = (n: string): Row => ({ migration_name: n, finished_at: null, rolled_back_at: null });
/** 已被 resolve --rolled-back 处理过的失败迁移:不该再算失败 */
const rolledBack = (n: string): Row => ({ migration_name: n, finished_at: null, rolled_back_at: new Date() });

describe('迁移状态自述', () => {
  it('全部已应用：ok，且说清应用到哪一个、共几个', async () => {
    const info = await makeService([done('a_1'), done('b_2')], ['a_1', 'b_2']).info();
    expect(info.ok).toBe(true);
    expect(info.latestApplied).toBe('b_2');
    expect(info.detail).toContain('b_2');
    expect(info.detail).toContain('2');
  });

  it('有未应用的迁移：不 ok，并点名是哪些', async () => {
    // 镜像里有 3 个，库里只应用了 2 个 —— 这正是「构建上了但迁移没跑」的样子
    const info = await makeService([done('a_1'), done('b_2')], ['a_1', 'b_2', 'c_3']).info();
    expect(info.ok).toBe(false);
    expect(info.pendingCount).toBe(1);
    expect(info.detail).toContain('c_3');
  });

  it('有失败的迁移（finished_at 为空）：不 ok，并点名', async () => {
    const info = await makeService([done('a_1'), unfinished('b_2')], ['a_1', 'b_2']).info();
    expect(info.ok).toBe(false);
    expect(info.failed).toEqual(['b_2']);
    expect(info.detail).toContain('b_2');
  });

  it('读不到迁移记录（表不存在/无权限）：不 ok，不假装健康', async () => {
    const info = await makeService(new Error('Table does not exist'), ['a_1']).info();
    expect(info.ok).toBe(false);
    expect(info.detail).toContain('无法读取');
    // 一个都没确认应用，pending 应等于镜像里的全部
    expect(info.pendingCount).toBe(1);
  });

  it('读不到镜像内的迁移目录：不 ok —— 这是本轮修掉的假保证', async () => {
    /*
     * 旧行为：inImage 为空 → pending 为空 → ok:true，
     * detail 仍是「已应用至 X，共 N 个」。
     * 而这句话在「不知道镜像里有什么」的前提下没有任何依据。
     */
    const info = await makeService([done('a_1'), done('b_2')], []).info();
    expect(info.ok).toBe(false);
    expect(info.detail).toContain('读不到');
    // 不能再输出「已应用至 …」那种确定语气
    expect(info.detail).not.toContain('已应用至');
  });
});

/*
 * 审计表的 append-only 触发器缺失是**静默**的:没有任何报错,
 * 任何 UPDATE/DELETE 都会照常成功。2026-08-04 的事故就是一个清理迁移
 * 在「摘掉」与「装回」之间失败了 —— 就绪检查不说,就没有任何地方会说。
 */
describe('审计 append-only 触发器', () => {
  it('两个都在 → ok,并把名字如实列出来', async () => {
    const info = await makeService([done('a_1')], ['a_1']).info();
    expect(info.ok).toBe(true);
    expect(info.auditTriggers).toEqual([...BOTH_TRIGGERS].sort());
  });

  it('元数据只作诊断:列出来什么就是什么,不拿它判不就绪', async () => {
    /*
     * 一开始我拿它当门禁,结果生产上 information_schema 查出来是空的
     * (那条摘/装触发器的迁移同一时刻明明应用成功了)—— 于是天天误报。
     * 门禁改由行为探测把关,这里只钉「如实列出」。
     */
    const one = await makeService([done('a_1')], ['a_1'], ['AuditLog_before_update_append_only']).info();
    expect(one.auditTriggers).toEqual(['AuditLog_before_update_append_only']);
    const none = await makeService([done('a_1')], ['a_1'], []).info();
    expect(none.auditTriggers).toEqual([]);
  });
});

it('被 resolve 标成回滚的迁移不算失败——否则恢复之后永远报假警报', async () => {
  /*
   * 2026-08-04:一条清理迁移失败 → 用 `migrate resolve --rolled-back` 标回未应用 →
   * 重放成功。但那条失败行仍留在 _prisma_migrations 里(finished_at 是 NULL),
   * 只多了 rolled_back_at。不排掉它,readiness 会一直说「有迁移失败」,
   * 而真出问题时这句话已经没人相信了。
   */
  const info = await makeService([rolledBack('a_1'), done('a_1'), done('b_2')], ['a_1', 'b_2']).info();
  expect(info.failed).toEqual([]);
  expect(info.ok).toBe(true);
});

/*
 * 元数据可能查不到(经数据库代理),但「审计到底删不删得动」必须有答案 ——
 * 所以直接在一个必定回滚的事务里试一次。
 */
describe('审计保护的行为探测', () => {
  it('被 45000 拦下 → ON,且判就绪', async () => {
    const info = await makeService([done('a_1')], ['a_1'], BOTH_TRIGGERS, 'ON').info();
    expect(info.auditProtection).toBe('ON');
    expect(info.ok).toBe(true);
  });

  it('居然改到了 → OFF,不就绪,并明说「可改可删」', async () => {
    const info = await makeService([done('a_1')], ['a_1'], BOTH_TRIGGERS, 'OFF').info();
    expect(info.auditProtection).toBe('OFF');
    expect(info.ok).toBe(false);
    expect(info.detail).toContain('可改可删');
  });

  it('审计表是空的 → UNKNOWN,不能据此判定不就绪(那会天天误报)', async () => {
    const info = await makeService([done('a_1')], ['a_1'], BOTH_TRIGGERS, 'EMPTY').info();
    expect(info.auditProtection).toBe('UNKNOWN');
    expect(info.ok).toBe(true);
  });

  it('元数据查不到触发器但行为探测说保护在 → 仍判就绪(元数据只作诊断)', async () => {
    /*
     * 2026-08-04 实测:information_schema 查出来是空的,而那条摘/装触发器的迁移
     * 明明应用成功了。拿元数据当门禁会天天误报,而误报久了就没人看了。
     */
    const info = await makeService([done('a_1')], ['a_1'], [], 'ON').info();
    expect(info.auditTriggers).toEqual([]);
    expect(info.ok).toBe(true);
  });
});
