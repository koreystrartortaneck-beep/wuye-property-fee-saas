import { ShareBy } from '@pf/shared';

export interface ShareHouse {
  id: string;
  area: string | null;
}

export interface ShareResult {
  /** houseId → 分 */
  alloc: Map<string, number>;
  /** 被跳过的 houseId（BY_AREA 下无面积） */
  skipped: string[];
}

/**
 * 公摊分摊（最大余数法，保证 sum(alloc) === totalCents）。
 * BY_AREA：按面积比例；BY_HOUSE：均分。
 */
export function allocateShare(totalCents: number, houses: ShareHouse[], shareBy: ShareBy): ShareResult {
  const skipped: string[] = [];
  const eligible =
    shareBy === 'AREA'
      ? houses.filter((h) => {
          if (h.area === null || Number(h.area) <= 0) {
            skipped.push(h.id);
            return false;
          }
          return true;
        })
      : [...houses];

  const alloc = new Map<string, number>();
  if (eligible.length === 0) return { alloc, skipped };

  // 权重
  const weights = eligible.map((h) => (shareBy === 'AREA' ? Number(h.area) : 1));
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  // 底额 + 余数
  const shares = eligible.map((h, i) => {
    const exact = (totalCents * weights[i]) / totalWeight;
    return { id: h.id, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let assigned = shares.reduce((s, x) => s + x.floor, 0);
  // 按余数从大到小补 1 分，直到守恒
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; assigned < totalCents; i = (i + 1) % byRemainder.length) {
    byRemainder[i].floor += 1;
    assigned += 1;
  }
  for (const s of shares) alloc.set(s.id, s.floor);
  return { alloc, skipped };
}
