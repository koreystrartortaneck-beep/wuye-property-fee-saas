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
type Row = { migration_name: string; finished_at: Date | null };

function makeService(rows: Row[] | Error, inImage: string[]) {
  const prisma = {
    raw: {
      $queryRawUnsafe: jest.fn(async () => {
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

const done = (n: string): Row => ({ migration_name: n, finished_at: new Date() });
const unfinished = (n: string): Row => ({ migration_name: n, finished_at: null });

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
