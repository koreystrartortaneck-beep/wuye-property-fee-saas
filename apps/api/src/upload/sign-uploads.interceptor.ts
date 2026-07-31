import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { signIfUploadPath } from './upload-access';

/**
 * 出口统一为本地上传路径现签。
 *
 * 为什么不逐处调 signUploadPaths：因为已经漏过了。
 * 工单列表签了、工单详情忘了签，结果是小区动态列表封面能显示、点进详情整页裂图 ——
 * 而这类缺陷在测试里看不出来（返回的仍是合法字符串数组），只有真机打开那一页才知道。
 * 同一个仓里还有 create / rate / process / done / close 五处返回整条记录，全是裸路径。
 *
 * 「每个出口都记得签」不是一个人能长期做到的约束：新加一个返回图片的端点就会再漏一次。
 * 所以改成在响应出口统一处理 —— 忘不掉，也不需要记。
 *
 * 覆盖范围刻意是「响应体里任意深度的 /uploads/... 字符串」而不是只认 images 字段：
 * 图片可能出现在 images、avatar、cover 或某个嵌套 DTO 里，按字段名白名单同样会漏。
 *
 * 幂等：已带签名的地址（含 sig=）原样返回，所以与残留的逐处调用可以共存，
 * 不会签两次签出一个坏地址。
 *
 * 成本：响应体都是分页后的结果（每页 ≤ 100 条），一次浅遍历，可忽略。
 * 深度上限防的是自引用对象造成的栈溢出 —— Prisma 结果不会自引用，但响应体不只有它。
 */

/** 遍历深度上限。Prisma 结果最深 3~4 层，16 层足够且能挡住异常结构。 */
const MAX_DEPTH = 16;

export function signUploadsDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return signIfUploadPath(value);
  if (Array.isArray(value)) {
    // 无改动时必须返回原数组：直接 map 会永远产出新数组，让上层的
    // 「没变就不复制」判断整棵树失效 —— 每个响应都被深复制一遍。
    let arrChanged = false;
    const mapped = value.map((v) => {
      const next = signUploadsDeep(v, depth + 1);
      if (next !== v) arrChanged = true;
      return next;
    });
    return arrChanged ? mapped : value;
  }
  // Date / Buffer / Decimal 等非 plain object 必须原样返回：
  // 展开它们会把 Date 变成 {} 、把金额 Decimal 变成内部字段，是比裂图严重得多的破坏。
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const src = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    const next = signUploadsDeep(src[k], depth + 1);
    if (next !== src[k]) changed = true;
    out[k] = next;
  }
  // 没有任何改动就返回原对象：绝大多数响应不含上传路径，避免整体复制。
  return changed ? out : value;
}

@Injectable()
export class SignUploadsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => signUploadsDeep(body)));
  }
}
