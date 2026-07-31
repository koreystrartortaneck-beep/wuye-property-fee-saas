import { Injectable, Logger } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 数据库迁移状态 —— 兼作「线上跑的是哪个版本」的标记。
 *
 * 为什么需要它：容器启动命令是 `prisma migrate deploy && node main.js`，迁移失败会
 * 让服务起不来，成功也没有任何地方能看出来。本次会话里为了确认「新版本上线了没」，
 * 每次都得临时造一个探针（找一个刚加的字段、刚加的检查项去轮询），既笨又不可靠——
 * 有一次判断成功时其实还是旧版本。
 *
 * 镜像里打包了 prisma/migrations 目录，数据库里有 _prisma_migrations 表。
 * 两者对比即可回答：镜像是哪个版本、迁移是否已全部应用、有没有失败的迁移。
 */

export interface SchemaVersionInfo {
  /** 镜像里最新的迁移目录名（等价于代码版本水位） */
  latestInImage: string | null;
  /** 数据库里最后一条成功应用的迁移名 */
  latestApplied: string | null;
  /** 镜像里有、但数据库未应用的迁移数（正常为 0） */
  pendingCount: number;
  /** 应用失败（有 started_at 无 finished_at）的迁移名 */
  failed: string[];
  ok: boolean;
  detail: string;
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
}

@Injectable()
export class SchemaVersionService {
  private readonly logger = new Logger(SchemaVersionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 镜像内的迁移目录名，按字典序（Prisma 的命名前缀是时间戳，字典序即时间序） */
  private migrationsInImage(): string[] {
    // 运行时工作目录是 apps/api，迁移目录随源码一起被 COPY 进镜像
    for (const dir of [
      path.join(process.cwd(), 'prisma', 'migrations'),
      path.join(__dirname, '..', '..', 'prisma', 'migrations'),
    ]) {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {
        // 换下一个候选路径
      }
    }
    return [];
  }

  async info(): Promise<SchemaVersionInfo> {
    const inImage = this.migrationsInImage();
    const latestInImage = inImage.length > 0 ? inImage[inImage.length - 1] : null;

    let rows: MigrationRow[] = [];
    try {
      rows = await this.prisma.raw.$queryRawUnsafe<MigrationRow[]>(
        'SELECT `migration_name`, `finished_at` FROM `_prisma_migrations` ORDER BY `migration_name`',
      );
    } catch (error) {
      // 表不存在或无权限：如实报告，不要假装健康
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`读取 _prisma_migrations 失败：${message}`);
      return {
        latestInImage,
        latestApplied: null,
        pendingCount: inImage.length,
        failed: [],
        ok: false,
        detail: `无法读取迁移记录：${message.slice(0, 120)}`,
      };
    }

    const applied = rows.filter((r) => r.finished_at !== null).map((r) => r.migration_name);
    const failed = rows.filter((r) => r.finished_at === null).map((r) => r.migration_name);
    const appliedSet = new Set(applied);
    const pending = inImage.filter((name) => !appliedSet.has(name));
    const latestApplied = applied.length > 0 ? applied[applied.length - 1] : null;

    /*
     * 读不到镜像里的迁移目录时**不能报健康**。
     *
     * migrationsInImage() 在两个候选路径都失败时返回空数组，于是 pending 也是空的，
     * ok 就成了 true，detail 还是「已应用至 X，共 N 个」——
     * 而此时它对「镜像里应该有哪些迁移」一无所知，那句话没有任何依据。
     *
     * 这个字段是判断部署是否生效的主要证据（本仓每次推送后都靠它核对），
     * 一个在自己瞎了的时候仍然说「一切正常」的检查，比没有这个检查更糟。
     */
    if (inImage.length === 0) {
      return {
        latestInImage,
        latestApplied: applied.length > 0 ? applied[applied.length - 1] : null,
        pendingCount: 0,
        failed,
        ok: false,
        detail: '读不到镜像内的迁移目录，无法判断是否有未应用的迁移（数据库中已记录 ' + applied.length + ' 个）',
      };
    }

    const ok = failed.length === 0 && pending.length === 0;
    let detail: string;
    if (failed.length > 0) {
      detail = `有 ${failed.length} 个迁移应用失败：${failed.join('、')}`;
    } else if (pending.length > 0) {
      detail = `有 ${pending.length} 个迁移未应用：${pending.join('、')}`;
    } else {
      detail = `已应用至 ${latestApplied ?? '（无迁移）'}，共 ${applied.length} 个`;
    }

    return { latestInImage, latestApplied, pendingCount: pending.length, failed, ok, detail };
  }
}
