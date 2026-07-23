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

export type RowIssueCode = 'DUPLICATE' | 'HOUSE_NOT_FOUND' | 'INVALID_AMOUNT' | 'PAID_CONFLICT';

export interface RowIssue {
  code: RowIssueCode;
  message: string;
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
  valid: boolean;
}

export interface ImportSummary {
  total: number;
  valid: number;
  invalid: number;
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

const PAID_LIKE_STATUSES: BillStatus[] = ['PAID', 'REFUNDING', 'REFUNDED'];

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
    const paidBills = houseIds.length
      ? await this.prisma.raw.bill.findMany({
          where: { houseId: { in: houseIds }, period, status: { in: PAID_LIKE_STATUSES } },
          select: { houseId: true },
        })
      : [];
    const paidHouseIds = new Set(paidBills.map((b) => b.houseId));

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
        issues.push({ code: 'PAID_CONFLICT', message: '该房屋本期已存在已缴账单' });
      }
      return {
        ...row,
        rowKey: row.houseCode || `row-${row.rowNo}`,
        houseId,
        amount: amountValid ? centsToStr(toCents(numeric)) : row.amount,
        title: row.title || defaultTitle,
        issues,
        valid: issues.length === 0,
      };
    });
  }

  private summarize(rows: ValidatedRow[]): ImportSummary {
    const valid = rows.filter((r) => r.valid);
    const totalCents = valid.reduce((sum, r) => sum + toCents(r.amount), 0);
    return { total: rows.length, valid: valid.length, invalid: rows.length - valid.length, totalAmount: centsToStr(totalCents) };
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
        summary: { total: existing.totalRows, valid: existing.validRows, invalid: existing.invalidRows, totalAmount: String(existing.totalAmount) },
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
          for (const row of validRows) {
            try {
              await tx.bill.create({
                data: {
                  tenantId,
                  communityId: input.communityId,
                  houseId: row.houseId as string,
                  ruleId: null,
                  batchId: b.id,
                  source: 'IMPORT',
                  sourceRowKey: row.rowKey,
                  period: input.period,
                  title: row.title,
                  snapshot: { importedFrom: input.fileName, houseCode: row.houseCode } as never,
                  amount: row.amount,
                  status: 'DRAFT',
                  dueDate,
                },
              });
            } catch (error) {
              // 行键幂等：撞 (tenantId,batchId,sourceRowKey) 视为已存在 → 跳过。
              if ((error as { code?: string }).code === 'P2002') continue;
              throw error;
            }
          }
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
              summary: { total: raced.totalRows, valid: raced.validRows, invalid: raced.invalidRows, totalAmount: String(raced.totalAmount) },
            };
          }
        }
        throw error;
      }
    });
  }
}
