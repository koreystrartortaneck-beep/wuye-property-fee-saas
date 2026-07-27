/**
 * CSV 导出（单一实现，供各列表页与报表复用）。
 *
 * 要点：
 * - 加 UTF-8 BOM，否则 Excel 打开中文会乱码；
 * - 字段一律加引号并转义内部引号，否则含逗号的房号/名称会错列；
 * - 用 CRLF 换行，兼容 Windows 版 Excel；
 * - blob URL 延后回收，立即 revoke 在部分浏览器会取消下载。
 */

/** 单元格可能是 null/数字/日期，统一成字符串 */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function escape(v: unknown): string {
  return `"${cell(v).replace(/"/g, '""')}"`;
}

export interface ExportColumn<T> {
  header: string;
  /** 取值函数；返回 null/undefined 会输出空单元格 */
  value: (row: T) => unknown;
}

/** 生成 CSV 文本（不触发下载，便于单测） */
export function toCsv<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const head = columns.map((c) => escape(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => escape(c.value(r))).join(','));
  return [head, ...body].join('\r\n');
}

/** 触发浏览器下载 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** 组合：直接导出一份表格 */
export function exportCsv<T>(filename: string, rows: T[], columns: ExportColumn<T>[]): void {
  downloadCsv(filename, toCsv(rows, columns));
}
