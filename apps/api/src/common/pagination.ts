import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 20;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function pageArgs(q: PageQuery): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function pageResult<T>(list: T[], total: number, q: PageQuery): PageResult<T> {
  return { list, total, page: q.page, pageSize: q.pageSize };
}
