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
 *
 * ── 入口侧是同一个问题的另一半 ──
 *
 * 出口统一现签之后，客户端手里的地址都带令牌。任何「读出来、改一改、提交回去」的
 * 编辑流程都会把带令牌的地址原样交回来，入库即成永久坏图（10 分钟后打不开，
 * 且从库里看不出原因）。
 *
 * 起初只在两个写入口调了 stripUploadSignature。随后发现 ServiceItem.coverImage
 * 是第三个 —— 和「出口逐处签会漏」完全一样的错误，我在同一天犯了第二次。
 * 所以入口也做成统一的：请求体里任意深度的 /uploads/ 路径一律剥掉查询串。
 *
 * 时序上成立：Nest 的拦截器 pre-handle 阶段在 ValidationPipe 之前，
 * 所以这里改过的 req.body 才是 DTO 最终收到的值。
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

/** 请求体侧：把 /uploads/ 路径上的查询串（访问令牌）剥掉，还原成可入库的裸路径 */
export function stripUploadSignaturesDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') {
    return value.startsWith('/uploads/') ? value.replace(/\?.*$/, '') : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((v) => {
      const next = stripUploadSignaturesDeep(v, depth + 1);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }
  if (value === null || typeof value !== 'object') return value;
  // Buffer 必须原样返回：支付回调用 rawBody 验签，动它就是签名验不过 —— 直接影响钱
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const src = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    const next = stripUploadSignaturesDeep(src[k], depth + 1);
    if (next !== src[k]) changed = true;
    out[k] = next;
  }
  return changed ? out : value;
}

@Injectable()
export class UploadPathsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ body?: unknown; path?: string; url?: string }>();
    if (req && req.body !== undefined) {
      const stripped = stripUploadSignaturesDeep(req.body);
      // 只在真有改动时赋值：避免给 rawBody 之类的特殊请求体换引用
      if (stripped !== req.body) req.body = stripped;
    }
    /*
     * 上传接口的响应**不能**签。
     *
     * 它返回的 url 是入库标识，契约就是裸路径（预览用另一个字段 viewUrl）。
     * 统一签名把 url 也签了，客户端拿到并存下来的就是带 10 分钟令牌的地址 ——
     * 正是这套机制一开始要防的东西。
     *
     * （入口侧的剥签名会在提交时把它还原，所以库里最终仍是裸路径；
     * 但让「返回入库标识」的接口先破坏自己的契约、再靠另一处兜回来，
     * 是把两个机制拧在一起 —— e2e 一跑就报了出来。）
     */
    const path = (req?.path || req?.url || '').split('?')[0];
    if (path.endsWith('/upload')) return next.handle();
    return next.handle().pipe(map((body) => signUploadsDeep(body)));
  }
}

/** 旧名保留：setup-app 与测试都已改用 UploadPathsInterceptor，这里只为兼容引用 */
export const SignUploadsInterceptor = UploadPathsInterceptor;
