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
  /*
   * AuditLog 的 append-only 触发器还在不在。
   *
   * 2026-08-04 的事故让这一项成为必查：一个清理迁移在「摘掉触发器」和
   * 「装回触发器」之间失败了，而**审计表失去保护是完全静默的** ——
   * 没有任何报错，任何 UPDATE/DELETE 都会照常成功。就绪检查必须能回答
   * 「那两个触发器现在在不在」，否则这套系统最核心的防篡改保证无人守着。
   */
  auditTriggers: string[];
  /*
   * 「审计真的删不动吗」—— 直接试一次,而不是去读元数据。
   *
   * 2026-08-04:information_schema.TRIGGERS 查出来是空的,而同一时刻那条
   * 摘/装触发器的迁移明明应用成功了。元数据经数据库代理可能就是查不到,
   * 于是我分不清「触发器没了」和「看不见触发器」——
   * 而这两者的严重性差着天壤:一个是防篡改保证已经失效,一个是虚惊一场。
   *
   * 所以改成**行为验证**:在一个必定回滚的事务里试着 UPDATE 一行审计,
   * 被 45000 拦下就是保护在,没拦下就是保护没了。这比任何元数据都可信。
   * ON = 拦下了,OFF = 没拦下(危险),UNKNOWN = 说不清(比如审计表是空的)。
   */
  auditProtection: 'ON' | 'OFF' | 'UNKNOWN';
  ok: boolean;
  detail: string;
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  /*
   * 被 `migrate resolve --rolled-back` 标记过的行:finished_at 也是 NULL,
   * 但它**不是**失败 —— 它是「已知失败、已处理、等着重放」。
   * 不排掉它,恢复之后 readiness 会永远报「有迁移失败」,而那是假警报。
   */
  rolled_back_at: Date | null;
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

  /**
   * 试着改一行审计 —— 全程在一个**一定会回滚**的事务里,不会留下任何痕迹。
   * 被 append-only 触发器拦下 = 保护在;顺利改到 = 保护没了。
   */
  private async probeAuditProtection(): Promise<'ON' | 'OFF' | 'UNKNOWN'> {
    const ROLLBACK = '__probe_rollback__';
    try {
      await this.prisma.raw.$transaction(async (tx) => {
        // 只碰一行,且把 reason 写成它自己(即使真被改到也不改变内容)
        const n = await tx.$executeRawUnsafe(
          'UPDATE `AuditLog` SET `reason` = `reason` WHERE `id` IN (SELECT `id` FROM (SELECT `id` FROM `AuditLog` LIMIT 1) AS t)',
        );
        // 一行都没碰到(审计表是空的)→ 触发器不会触发,这一次探测说明不了任何事
        throw new Error(n > 0 ? ROLLBACK : 'EMPTY');
      });
      return 'UNKNOWN';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('append-only')) return 'ON';
      if (message.includes(ROLLBACK)) return 'OFF';
      if (message.includes('EMPTY')) return 'UNKNOWN';
      this.logger.warn(`审计保护探测失败：${message.slice(0, 160)}`);
      return 'UNKNOWN';
    }
  }

  async info(): Promise<SchemaVersionInfo> {
    const inImage = this.migrationsInImage();
    const latestInImage = inImage.length > 0 ? inImage[inImage.length - 1] : null;

    // 触发器读不到不影响其它判断,单独兜住
    let auditTriggers: string[] = [];
    try {
      /*
       * 显式取别名:列名大小写在驱动之间不一致,直接读 TRIGGER_NAME 拿到的是 undefined,
       * 于是「触发器全没了」这个**假警报**会盖过真问题(2026-08-04 踩过)。
       * 也不按 DATABASE() 过滤 —— 库名不匹配时宁可多列几个,也别把「看不见」
       * 报成「不存在」。
       */
      const trs = await this.prisma.raw.$queryRawUnsafe<Array<{ name: string }>>(
        "SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_TABLE = 'AuditLog'",
      );
      auditTriggers = trs.map((t) => t.name).filter(Boolean).sort();
    } catch (error) {
      this.logger.warn(`读取审计触发器失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const auditProtection = await this.probeAuditProtection();

    let rows: MigrationRow[] = [];
    try {
      rows = await this.prisma.raw.$queryRawUnsafe<MigrationRow[]>(
        'SELECT `migration_name`, `finished_at`, `rolled_back_at` FROM `_prisma_migrations` ORDER BY `migration_name`',
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
        auditTriggers,
        auditProtection,
        ok: false,
        detail: `无法读取迁移记录：${message.slice(0, 120)}`,
      };
    }

    const applied = rows.filter((r) => r.finished_at !== null).map((r) => r.migration_name);
    const failed = rows.filter((r) => r.finished_at === null && r.rolled_back_at === null).map((r) => r.migration_name);
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
        auditTriggers,
        auditProtection,
        ok: false,
        detail: '读不到镜像内的迁移目录，无法判断是否有未应用的迁移（数据库中已记录 ' + applied.length + ' 个）',
      };
    }

    /*
     * 触发器缺失也算不就绪。审计表失去保护是静默的 —— 不在这里说出来,
     * 就没有任何地方会说。
     */
    /*
     * 判「不就绪」只认行为探测的 OFF。
     * auditTriggers 是元数据,经数据库代理可能查不到 —— 拿它当门禁会天天误报,
     * 而误报久了就没人看了。它只留作诊断信息。
     */
    const ok = failed.length === 0 && pending.length === 0 && auditProtection !== 'OFF';
    let detail: string;
    if (failed.length > 0) {
      detail = `有 ${failed.length} 个迁移应用失败：${failed.join('、')}`;
    } else if (pending.length > 0) {
      detail = `有 ${pending.length} 个迁移未应用：${pending.join('、')}`;
    } else {
      detail = `已应用至 ${latestApplied ?? '（无迁移）'}，共 ${applied.length} 个`;
    }

    if (auditProtection === 'OFF') {
      detail = '审计表的 append-only 保护已失效（实测能改到审计行）—— 审计记录目前可改可删，必须立即修复。' + detail;
    }
    return {
      latestInImage,
      latestApplied,
      pendingCount: pending.length,
      failed,
      auditTriggers,
      auditProtection,
      ok,
      detail,
    };
  }
}
