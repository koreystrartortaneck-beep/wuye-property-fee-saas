import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { BillStatus, ErrorCode } from '@pf/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { AuditService } from '../audit/audit.service';
import { BizException } from '../common/biz.exception';
import { toCents, centsToStr } from './engine/money';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTenant } from '../tenant/tenant-cls';

export type RowIssueCode =
  | 'DUPLICATE'
  | 'HOUSE_NOT_FOUND'
  | 'INVALID_AMOUNT'
  | 'PAID_CONFLICT'
  | 'REFUNDED_EXISTS'
  | 'DRAFT_EXISTS'
  | 'UNPAID_EXISTS';

/**
 * severity 决定这一行还能不能导入：
 *   'error'（默认）—— 阻断该行；
 *   'warn'         —— 允许导入但必须在预览里显眼提示，由物业判断。
 *
 * 需要 warn 这一档的原因：同房同期存在多张账单本身是合法的（物业费、水费、
 * 车位费各一张），所以「已有一张未缴账单」不能一律阻断，否则正常的多费项导入
 * 全都做不了；但它也确实是重复收款的高发点，不能像现在这样一声不响。
 */
export interface RowIssue {
  code: RowIssueCode;
  message: string;
  severity?: 'error' | 'warn';
}

export interface ParsedRow {
  rowNo: number;
  houseCode: string;
  amount: string;
  title: string;
}

export interface ValidatedRow extends ParsedRow {
  rowKey: string;
  houseId: string | null;
  issues: RowIssue[];
  /** 无 error 级问题即可导入（warn 不阻断） */
  valid: boolean;
  /** 有 warn 级问题：可导入，但需要物业确认 */
  needsReview: boolean;
}

export interface ImportSummary {
  total: number;
  valid: number;
  invalid: number;
  /** 可导入但存在重复风险、需物业确认的行数 */
  needsReview: number;
  totalAmount: string;
}

export interface PreviewResult {
  fileHash: string;
  period: string;
  title: string;
  summary: ImportSummary;
  rows: ValidatedRow[];
}

export interface ImportInput {
  communityId: string;
  period: string;
  title?: string | null;
  fileName: string;
  buffer: Buffer;
  adminId: string;
  actingTenantId: string | null;
  dueDate?: Date | null;
  requestId?: string;
}

/*
 * 阻断级：钱还在我们这儿（已缴），或正在退的路上。
 * 这两种情况下再导一张同期账单，业主会被收两次。
 */
const BLOCKING_PAID_STATUSES: BillStatus[] = ['PAID', 'REFUNDING'];

/*
 * REFUNDED 不阻断。
 *
 * 2026-08-02 实测撞到：一张 ¥0.01 的账单缴过又退了，之后这户这个账期
 * **再也导不进任何账单** —— 提示「该房屋本期已存在已缴账单」。
 * 而退款的意义恰恰是撤销那笔收款：钱已经回到业主手里，这笔费用在实质上没缴，
 * 重新出账是完全正常的需求（收错了金额、退款重开，都会走到这里）。
 *
 * 但也不能一声不响：同期存在退款记录时，物业应当看一眼是不是重复出账，
 * 所以降为 warn。
 */
const REFUNDED_STATUSES: BillStatus[] = ['REFUNDED'];

function normalizeHeader(raw: string): 'houseCode' | 'amount' | 'title' | null {
  const key = raw.trim().toLowerCase();
  if (['housecode', 'house_code', '房号', '房屋编码', '房屋编号'].includes(key)) return 'houseCode';
  if (['amount', '金额', '费用金额'].includes(key)) return 'amount';
  if (['title', '标题', '费用名称', '费用科目'].includes(key)) return 'title';
  return null;
}

/**
 * 账单导入：解析 .csv/.xlsx（结构化解析器，禁用 split(',')），逐行校验
 * （重复行 / 房屋不存在 / 金额非法 / 已缴冲突），支持预览与显式确认落草稿批次。
 * 文件哈希幂等：同文件重复上传复用同一批次；行键幂等：(tenantId,batchId,sourceRowKey) 唯一。
 */
@Injectable()
export class BillImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  fileHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  async parse(fileName: string, buffer: Buffer): Promise<ParsedRow[]> {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.csv')) return this.parseCsvBuffer(buffer);
    if (lower.endsWith('.xlsx')) return this.parseXlsxBuffer(buffer);
    throw new BizException(ErrorCode.UPLOAD_INVALID, '仅支持 .csv 或 .xlsx 账单文件');
  }

  private parseCsvBuffer(buffer: Buffer): ParsedRow[] {
    let records: Record<string, string>[];
    try {
      records = parseCsv(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch {
      throw new BizException(ErrorCode.UPLOAD_INVALID, 'CSV 解析失败');
    }
    return records.map((record, index) => {
      const mapped: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) {
        const header = normalizeHeader(key);
        if (header) mapped[header] = value ?? '';
      }
      return this.toParsedRow(index + 2, mapped);
    });
  }

  private async parseXlsxBuffer(buffer: Buffer): Promise<ParsedRow[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new BizException(ErrorCode.UPLOAD_INVALID, 'XLSX 解析失败');
    }
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new BizException(ErrorCode.UPLOAD_INVALID, '工作表为空');
    const headerRow = worksheet.getRow(1);
    const columns: Record<number, 'houseCode' | 'amount' | 'title'> = {};
    headerRow.eachCell((cell, col) => {
      const header = normalizeHeader(String(cell.value ?? ''));
      if (header) columns[col] = header;
    });
    const rows: ParsedRow[] = [];
    for (let rowNo = 2; rowNo <= worksheet.rowCount; rowNo += 1) {
      const row = worksheet.getRow(rowNo);
      const mapped: Record<string, string> = {};
      for (const [colStr, header] of Object.entries(columns)) {
        const cell = row.getCell(Number(colStr));
        mapped[header] = cell.value === null || cell.value === undefined ? '' : String(cell.value);
      }
      if (!mapped.houseCode && !mapped.amount) continue; // 跳过整行空白
      rows.push(this.toParsedRow(rowNo, mapped));
    }
    return rows;
  }

  private toParsedRow(rowNo: number, mapped: Record<string, string>): ParsedRow {
    return {
      rowNo,
      houseCode: (mapped.houseCode ?? '').trim(),
      amount: (mapped.amount ?? '').trim(),
      title: (mapped.title ?? '').trim(),
    };
  }

  /** 校验解析结果：返回逐行 issues 与合计摘要（不落库）。 */
  async validateRows(
    communityId: string,
    period: string,
    rows: ParsedRow[],
    defaultTitle: string,
  ): Promise<ValidatedRow[]> {
    const codes = [...new Set(rows.map((r) => r.houseCode).filter(Boolean))];
    const houses = codes.length
      ? await this.prisma.raw.house.findMany({ where: { communityId, code: { in: codes } }, select: { id: true, code: true } })
      : [];
    const codeToId = new Map(houses.map((h) => [h.code, h.id]));
    const houseIds = houses.map((h) => h.id);
    /*
     * 除「已缴」外，还要看同房同期是否已有**未缴**账单。
     *
     * 原实现只查 PAID_LIKE_STATUSES（PAID/REFUNDING/REFUNDED），DRAFT/UNPAID 一声不响。
     * 而导入的账单 ruleId 为 null，MySQL 唯一键对 NULL 不去重，
     * @@unique([ruleId,houseId,period]) 形同不存在；行键唯一约束是
     * @@unique([tenantId,batchId,sourceRowKey])，只在**同一批次内**去重，跨批次无效。
     * 于是同一份表格换个批次再导一次，或规则已出账后又导一遍，就会多出一张待缴账单。
     *
     * 这不是理论问题：生产库里两户各有两张 2026-07 物业费同时待缴
     * （「2026年07月物业费」¥0.01 与「住宅物业费 2026-07」¥222.50），业主都能付。
     *
     * 按 warn 而非 error 处理：标题不同的多费项导入是合法的（水费 + 物业费），
     * 而规则生成的标题（「住宅物业费 2026-07」）与导入的默认标题
     * （「2026年07月物业费」）本来就不一样，靠标题精确比对反而抓不住真实情况。
     * 所以一律提示，把判断交给看得懂业务的人。
     */
    const sameperiodBills = houseIds.length
      ? await this.prisma.raw.bill.findMany({
          where: { houseId: { in: houseIds }, period, status: { notIn: ['CANCELED'] } },
          select: { houseId: true, title: true, amount: true, status: true },
        })
      : [];
    const paidHouseIds = new Set(
      sameperiodBills.filter((b) => BLOCKING_PAID_STATUSES.includes(b.status)).map((b) => b.houseId),
    );
    const refundedHouseIds = new Set(
      sameperiodBills.filter((b) => REFUNDED_STATUSES.includes(b.status)).map((b) => b.houseId),
    );
    /*
     * 草稿与已发布的待缴必须分开说。
     *
     * 原来两者混在一起，提示一律是「导入后业主会看到两张、可能重复缴费」——
     * 而**草稿账单业主根本看不到**，这句话对草稿是错的。
     * 草稿的风险在别处：等它被发布时才会变成两张，那时没人会想起这次导入。
     */
    const unpaidByHouse = new Map<string, Array<{ title: string; amount: string }>>();
    const draftByHouse = new Map<string, Array<{ title: string; amount: string }>>();
    for (const b of sameperiodBills) {
      const target = b.status === 'UNPAID' ? unpaidByHouse : b.status === 'DRAFT' ? draftByHouse : null;
      if (!target) continue;
      const list = target.get(b.houseId) ?? [];
      list.push({ title: b.title, amount: String(b.amount) });
      target.set(b.houseId, list);
    }

    const seen = new Map<string, number>();
    for (const row of rows) if (row.houseCode) seen.set(row.houseCode, (seen.get(row.houseCode) ?? 0) + 1);

    return rows.map((row) => {
      const issues: RowIssue[] = [];
      const houseId = row.houseCode ? codeToId.get(row.houseCode) ?? null : null;
      if (!row.houseCode) issues.push({ code: 'HOUSE_NOT_FOUND', message: '缺少房号' });
      else if ((seen.get(row.houseCode) ?? 0) > 1) issues.push({ code: 'DUPLICATE', message: '文件内房号重复' });
      if (row.houseCode && !houseId) issues.push({ code: 'HOUSE_NOT_FOUND', message: `房号 ${row.houseCode} 不属于该小区` });

      let amountValid = false;
      const numeric = Number(row.amount);
      if (!row.amount || !Number.isFinite(numeric) || numeric <= 0) {
        issues.push({ code: 'INVALID_AMOUNT', message: '金额必须为大于 0 的数字' });
      } else {
        amountValid = true;
      }
      if (houseId && paidHouseIds.has(houseId)) {
        issues.push({ code: 'PAID_CONFLICT', message: '该房屋本期已存在已缴账单', severity: 'error' });
      }
      if (houseId && refundedHouseIds.has(houseId)) {
        issues.push({
          code: 'REFUNDED_EXISTS',
          severity: 'warn',
          message: '该房屋本期有已退款的账单。退款已把钱退回业主，重新出账是正常的；请确认不是重复出账',
        });
      }
      const unpaid = houseId ? unpaidByHouse.get(houseId) : undefined;
      if (unpaid?.length) {
        issues.push({
          code: 'UNPAID_EXISTS',
          severity: 'warn',
          message:
            `该房屋本期已有待缴账单：${unpaid.map((b) => `${b.title} ¥${b.amount}`).join('、')}。` +
            '若与本行是同一笔费用，导入后业主会看到两张、可能重复缴费',
        });
      }
      const draft = houseId ? draftByHouse.get(houseId) : undefined;
      if (draft?.length) {
        issues.push({
          code: 'DRAFT_EXISTS',
          severity: 'warn',
          message:
            `该房屋本期已有未发布的草稿账单：${draft.map((b) => `${b.title} ¥${b.amount}`).join('、')}。` +
            '草稿业主看不到，但那批账单一旦发布就会变成两张',
        });
      }
      const errors = issues.filter((i) => (i.severity ?? 'error') === 'error');
      return {
        ...row,
        rowKey: row.houseCode || `row-${row.rowNo}`,
        houseId,
        amount: amountValid ? centsToStr(toCents(numeric)) : row.amount,
        title: row.title || defaultTitle,
        issues,
        valid: errors.length === 0,
        needsReview: issues.some((i) => i.severity === 'warn'),
      };
    });
  }

  private summarize(rows: ValidatedRow[]): ImportSummary {
    const valid = rows.filter((r) => r.valid);
    const totalCents = valid.reduce((sum, r) => sum + toCents(r.amount), 0);
    return {
      total: rows.length,
      valid: valid.length,
      invalid: rows.length - valid.length,
      needsReview: rows.filter((r) => r.needsReview).length,
      totalAmount: centsToStr(totalCents),
    };
  }

  async preview(input: ImportInput): Promise<PreviewResult> {
    this.assertTenant(input);
    const parsed = await this.parse(input.fileName, input.buffer);
    const defaultTitle = input.title?.trim() || `导入账单 ${input.period}`;
    const rows = await this.validateRows(input.communityId, input.period, parsed, defaultTitle);
    return {
      fileHash: this.fileHash(input.buffer),
      period: input.period,
      title: defaultTitle,
      summary: this.summarize(rows),
      rows,
    };
  }

  private assertTenant(input: ImportInput): void {
    // 小区归属在事务内以 tenantId 隔离；此处仅拦截缺失上下文的越权（controller 已加管理员守卫）。
    if (input.actingTenantId === null) {
      throw new BizException(ErrorCode.FORBIDDEN, '平台超管需指定租户后导入');
    }
  }

  /** 确认导入：为有效行创建草稿批次与草稿账单（不自动发布），非法行拒绝且不部分发布。 */
  async confirm(input: ImportInput): Promise<{ batchId: string; status: string; summary: ImportSummary }> {
    this.assertTenant(input);
    const tenantId = input.actingTenantId as string;
    const community = await this.prisma.raw.community.findFirst({
      where: { id: input.communityId, tenantId },
      select: { id: true },
    });
    if (!community) throw new BizException(ErrorCode.NOT_FOUND, '小区不存在');

    const fileHash = this.fileHash(input.buffer);
    const existing = await this.prisma.raw.billBatch.findFirst({
      where: { tenantId, communityId: input.communityId, importFileHash: fileHash },
    });
    if (existing) {
      // 文件哈希幂等：同文件重复上传复用同一批次。
      return {
        batchId: existing.id,
        status: existing.status,
        // needsReview 是逐行校验的产物，批次表里没有这一列；重复上传走幂等分支时
        // 不再重新校验，故记 0（此时账单已落库，提示已在首次预览时给过）。
        summary: {
          total: existing.totalRows,
          valid: existing.validRows,
          invalid: existing.invalidRows,
          needsReview: 0,
          totalAmount: String(existing.totalAmount),
        },
      };
    }

    const parsed = await this.parse(input.fileName, input.buffer);
    const defaultTitle = input.title?.trim() || `导入账单 ${input.period}`;
    const rows = await this.validateRows(input.communityId, input.period, parsed, defaultTitle);
    const summary = this.summarize(rows);
    const validRows = rows.filter((r) => r.valid);
    if (validRows.length === 0) throw new BizException(ErrorCode.VALIDATION, '没有可导入的有效账单行');

    const dueDate = input.dueDate ?? (() => {
      const d = new Date();
      d.setDate(d.getDate() + 15);
      d.setHours(23, 59, 59, 0);
      return d;
    })();

    return runWithTenant(tenantId, async () => {
      const batchNo = `IMP-${input.period}-${Date.now().toString(36)}`;
      try {
        const batch = await this.prisma.raw.$transaction(async (tx) => {
          const b = await tx.billBatch.create({
            data: {
              tenantId,
              communityId: input.communityId,
              batchNo,
              period: input.period,
              title: defaultTitle,
              source: 'IMPORT',
              importFileName: input.fileName,
              importFileHash: fileHash,
              status: 'DRAFT',
              totalRows: summary.total,
              validRows: summary.valid,
              invalidRows: summary.invalid,
              totalAmount: summary.totalAmount,
              createdBy: input.adminId,
            },
          });
          /*
           * 一次 createMany 取代逐行 create。
           *
           * 逐行是每行 1 次数据库往返，而事务没有设 timeout、走 Prisma 默认 5000ms：
           *     100 行 →  102 次 ≈ 0.3s
           *   1600 行 → 1602 次 ≈ 4.8s  ← 临界点
           *   3000 行 → 3002 次 ≈ 9.0s  → P2028 事务超时、全量回滚
           * 而上传限制是 5MB（约 3000 行 xlsx 只有 60KB），行数本身没有上限，
           * 也就是说一个楼盘的完整账单表根本导不进来，且失败时物业只看到一个 500。
           *
           * skipDuplicates 完整承接原来的 P2002 行键幂等语义
           * （@@unique([tenantId, batchId, sourceRowKey])）。
           */
          await tx.bill.createMany({
            data: validRows.map((row) => ({
              tenantId,
              communityId: input.communityId,
              houseId: row.houseId as string,
              ruleId: null,
              batchId: b.id,
              source: 'IMPORT',
              sourceRowKey: row.rowKey,
              period: input.period,
              title: row.title,
              snapshot: { importedFrom: input.fileName, houseCode: row.houseCode } as Prisma.InputJsonValue,
              amount: row.amount,
              status: 'DRAFT',
              dueDate,
            })),
            skipDuplicates: true,
          });
          await this.audit.append(
            {
              tenantId,
              communityId: input.communityId,
              actorType: 'ADMIN',
              actorId: input.adminId,
              action: 'CREATE',
              resourceType: 'BillBatch',
              resourceId: b.id,
              requestId: input.requestId ?? null,
              afterSummary: {
                source: 'IMPORT',
                fileHash,
                ...summary,
                issues: rows.filter((r) => !r.valid).map((r) => ({ rowNo: r.rowNo, houseCode: r.houseCode, issues: r.issues })),
              },
            },
            tx,
          );
          return b;
        }, {
          // 与 outbox.service.ts 对齐。默认 5s 在 1600 行左右就会超时并全量回滚。
          maxWait: 5_000,
          timeout: 30_000,
        });
        return { batchId: batch.id, status: 'DRAFT', summary };
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          const raced = await this.prisma.raw.billBatch.findFirst({
            where: { tenantId, communityId: input.communityId, importFileHash: fileHash },
          });
          if (raced) {
            return {
              batchId: raced.id,
              status: raced.status,
              // 同上：needsReview 是逐行校验的产物，批次表无此列，竞态分支记 0
              summary: {
                total: raced.totalRows,
                valid: raced.validRows,
                invalid: raced.invalidRows,
                needsReview: 0,
                totalAmount: String(raced.totalAmount),
              },
            };
          }
        }
        throw error;
      }
    });
  }
}
