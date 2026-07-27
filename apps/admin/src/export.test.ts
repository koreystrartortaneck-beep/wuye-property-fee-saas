import { describe, expect, it } from 'vitest';
import { toCsv, type ExportColumn } from './export';

/**
 * 转义错了整张报表就会错列，是导出功能最容易出错也最难察觉的地方。
 */
describe('toCsv', () => {
  interface Row {
    code: string;
    name: string | null;
    amount: number;
  }
  const cols: ExportColumn<Row>[] = [
    { header: '房号', value: (r) => r.code },
    { header: '名称', value: (r) => r.name },
    { header: '金额', value: (r) => r.amount },
  ];

  it('表头与数据都加引号，用 CRLF 分行', () => {
    const csv = toCsv([{ code: '1-101', name: '张三', amount: 222.5 }], cols);
    expect(csv).toBe('"房号","名称","金额"\r\n"1-101","张三","222.5"');
  });

  it('字段含逗号时不会错列', () => {
    const csv = toCsv([{ code: 'A,1', name: '张三,李四', amount: 1 }], cols);
    expect(csv.split('\r\n')[1]).toBe('"A,1","张三,李四","1"');
  });

  it('字段含引号时按 CSV 规范双写转义', () => {
    const csv = toCsv([{ code: '1"01', name: null, amount: 0 }], cols);
    expect(csv.split('\r\n')[1]).toBe('"1""01","","0"');
  });

  it('null / undefined 输出空单元格而非 "null"', () => {
    const csv = toCsv([{ code: 'x', name: null, amount: 0 }], cols);
    expect(csv).not.toContain('null');
  });

  it('空数据仍输出表头，便于用户确认导出成功', () => {
    expect(toCsv([], cols)).toBe('"房号","名称","金额"');
  });

  it('字段含换行时被引号包裹，不会截断成两行', () => {
    const csv = toCsv([{ code: 'a\nb', name: 'n', amount: 1 }], cols);
    expect(csv.split('\r\n')).toHaveLength(2);
  });
});
