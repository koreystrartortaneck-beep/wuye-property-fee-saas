import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCode } from '@pf/shared';
import { redactAndTruncateText } from '../audit/audit.service';
import { BizException } from './biz.exception';
import { Prisma } from '@prisma/client';

/**
 * 全局异常 → 统一 {code,message} 响应，HTTP 200（spec §7）。
 * 未知异常记日志并返回 50000，不泄漏堆栈。
 *
 * 唯一例外是「路由没匹配上」：那类请求根本没进业务逻辑，报 200 会让微信支付
 * 回调被永久吞掉（详见下方 NotFoundException 分支）。
 */
/** 常见字段名 → 中文，避免界面上出现英文字段名 */
const FIELD_CN: Record<string, string> = {
  houseType: '适用房屋类型',
  ruleType: '计费方式',
  dueDays: '缴费期限',
  billDay: '出账日',
  period: '账期',
  unitPrice: '单价',
  amount: '金额',
  area: '面积',
  name: '名称',
  code: '编号',
  reason: '原因',
  requestId: '请求标识',
  communityId: '小区',
  houseId: '房屋',
  billId: '账单',
  orderNo: '订单号',
  voucherNo: '凭证号',
  paidAt: '缴费时间',
  status: '状态',
  page: '页码',
  pageSize: '每页条数',
  title: '标题',
  content: '内容',
  phone: '手机号',
  username: '用户名',
  password: '密码',
  visitDate: '到访日期',
  meterType: '计量表类型',
  shareBy: '分摊方式',
};

function fieldCn(raw: string): string {
  const key = raw.split('.').pop() ?? raw;
  return FIELD_CN[key] ?? key;
}

/** 把 class-validator 的英文提示译成中文；无法识别时原样返回 */
function humanizeValidation(msg?: string): string | undefined {
  if (!msg) return msg;
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^(\S+) must be one of the following values: (.+)$/, (m) => `${fieldCn(m[1])} 取值不合法（仅支持：${m[2]}）`],
    [/^(\S+) must not be greater than (\S+)$/, (m) => `${fieldCn(m[1])} 不能大于 ${m[2]}`],
    [/^(\S+) must not be less than (\S+)$/, (m) => `${fieldCn(m[1])} 不能小于 ${m[2]}`],
    [/^(\S+) should not be empty$/, (m) => `请填写${fieldCn(m[1])}`],
    [/^(\S+) must be a number.*$/, (m) => `${fieldCn(m[1])} 必须是数字`],
    [/^(\S+) must be an integer.*$/, (m) => `${fieldCn(m[1])} 必须是整数`],
    [/^(\S+) must be a string$/, (m) => `${fieldCn(m[1])} 格式不正确`],
    [/^(\S+) must be a valid enum value$/, (m) => `${fieldCn(m[1])} 取值不合法`],
    [/^(\S+) must be a Date instance$/, (m) => `${fieldCn(m[1])} 日期格式不正确`],
    [/^(\S+) must be an email$/, (m) => `${fieldCn(m[1])} 邮箱格式不正确`],
    [/^(\S+) must be longer than or equal to (\S+) characters$/, (m) => `${fieldCn(m[1])} 至少 ${m[2]} 个字符`],
    [/^(\S+) must be shorter than or equal to (\S+) characters$/, (m) => `${fieldCn(m[1])} 最多 ${m[2]} 个字符`],
    [/^(\S+) must match .*regular expression.*$/, (m) => `${fieldCn(m[1])} 格式不正确`],
    [/^property (\S+) should not exist$/, (m) => `不支持的参数：${fieldCn(m[1])}`],
  ];
  for (const [re, fn] of patterns) {
    const m = msg.match(re);
    if (m) return fn(m);
  }
  return msg;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    // 请求方法用来区分 P2003 的两种相反方向，见下面那段注释
    const req = host.switchToHttp().getRequest<Request>();

    if (exception instanceof BizException) {
      res.status(200).json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof BadRequestException) {
      // class-validator 校验失败：取第一条并译为中文，避免把
      // "houseType must be one of the following values: ..." 直接抛给收费员
      const body = exception.getResponse() as { message?: string | string[] };
      const detail = Array.isArray(body.message) ? body.message[0] : body.message;

      /*
       * 请求体不是合法 JSON 时，Nest 的 body-parser 也抛 BadRequestException，
       * 但 message 是解析器的英文原文，例如
       *   "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
       * humanizeValidation 认不出它，于是原样透传——既不可读，也把内部实现细节
       * （解析器行为、字符位置）暴露给了调用方。实测生产就是这样返回的。
       */
      if (typeof detail === 'string' && /JSON at position|Unexpected token|Unexpected end of JSON/i.test(detail)) {
        this.logger.warn(`请求体 JSON 解析失败：${detail.slice(0, 120)}`);
        res.status(200).json({
          code: ErrorCode.VALIDATION.code,
          message: '请求内容格式不正确，请重试；若反复出现请联系技术支持',
        });
        return;
      }
      res.status(200).json({
        code: ErrorCode.VALIDATION.code,
        message: humanizeValidation(detail) || ErrorCode.VALIDATION.message,
      });
      return;
    }

    if (exception instanceof UnauthorizedException) {
      res.status(200).json(ErrorCode.UNAUTHORIZED);
      return;
    }
    if (exception instanceof ForbiddenException) {
      res.status(200).json(ErrorCode.FORBIDDEN);
      return;
    }
    if (exception instanceof NotFoundException) {
      /*
       * 这个分支**只可能是 Nest 路由没匹配上**：业务代码一律抛
       * BizException(ErrorCode.NOT_FOUND)（走上面第一支），全库没有一处
       * 直接 new NotFoundException。也就是说走到这里的请求根本没进业务逻辑。
       *
       * 所以这里是 §7「HTTP 始终 200」的唯一例外，代价太大：
       *
       * 微信支付回调按 HTTP 状态码判定投递结果 —— 200 表示「已受理，不再重试」。
       * 若 WX_PAY_NOTIFY_URL 配错一个字符（最常见是漏掉 /api/v1 前缀），
       * 微信 POST 过来会命中这一支、拿到 HTTP 200，于是认为回调成功投递并
       * **永久不再重试**。业主的钱扣了，账单永远不变，而系统里没有任何痕迹：
       * 没进验签代码所以没有告警，微信侧显示投递成功所以也不重试。
       * 2026-08-01 的事故正是这个形状。
       *
       * 同理，任何按 HTTP 状态做健康检查的外部系统，在路由被改坏时也一律看到 200。
       *
       * 响应体保持不变：两个前端都只读 body.code、不看 HTTP 状态
       * （wx.request 的 success 对 404 同样触发，fetch 也不会 reject），
       * 所以这个改动对它们完全兼容。
       */
      res.status(404).json(ErrorCode.NOT_FOUND);
      return;
    }
    if (exception instanceof HttpException) {
      res.status(200).json({ code: 40000 + exception.getStatus(), message: exception.message });
      return;
    }

    /*
     * Prisma 已知错误必须翻译成可操作的提示，而不是一句「服务器内部错误」。
     *
     * 实测：给小区名称或退款原因塞 300 个汉字，接口返回 50000——物业完全不知道
     * 为什么失败。退款那条尤其糟：一次资金操作失败却只给「服务器内部错误」。
     *
     * 这是兜底层。DTO 上也在补 @MaxLength，但字段近百个、手工标注必然有遗漏，
     * 所以这里保证「无论漏了哪个字段，用户看到的都是能照着改的提示」。
     */
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = (exception.meta ?? {}) as { target?: unknown; column_name?: unknown; modelName?: unknown };
      /*
       * 字段名要译成中文，且剔除 tenantId 这类内部字段。
       *
       * Prisma 的 P2002 meta.target 是索引涉及的全部列，例如
       * @@unique([tenantId, name]) 会给出 ['tenantId','name']——直接拼出来是
       * 「「tenantId、name」已存在」，对物业来说是天书。复用 FIELD_CN 译名，
       * 并去掉租户 ID（用户不关心、也不该看到内部维度）。
       */
      const rawFields = Array.isArray(meta.target)
        ? (meta.target as unknown[]).map(String)
        : [String(meta.column_name ?? meta.target ?? '')].filter(Boolean);
      const field = rawFields
        .filter((f) => f !== 'tenantId' && f !== 'id')
        .map((f) => fieldCn(f))
        .join('、');
      switch (exception.code) {
        case 'P2000': // 字段值超出数据库列长度
          res.status(200).json({
            code: ErrorCode.VALIDATION.code,
            message: field ? `「${field}」内容过长，请缩短后重试` : '有字段内容过长，请缩短后重试',
          });
          return;
        case 'P2002': // 唯一约束冲突
          res.status(200).json({
            code: ErrorCode.VALIDATION.code,
            message: field ? `「${field}」已存在，不能重复` : '该记录已存在，不能重复',
          });
          return;
        case 'P2003':
          /*
           * P2003 覆盖两种**方向相反**的外键失败，原来只给了其中一种的说法：
           *
           *   · 写入时，外键指向的记录不存在  → 「关联的数据不存在」，对
           *   · 删除时，还有别的记录指着它    → 「关联的数据不存在」，完全说反了。
           *     真实情况是它存在得好好的，正因为存在才删不掉。
           *
           * 2026-08-02 实测：删一个已经清空房屋的小区，界面告诉物业
           * 「关联的数据不存在或已被删除，请刷新后重试」——
           * 于是他去刷新，再删，再看到同一句话。这句话把人指向了完全错误的方向。
           *
           * Prisma 的错误里没有可靠字段区分这两种方向，但请求方法可以：
           * DELETE 必然是「还被引用」那一种。
           */
          res.status(200).json({
            code: ErrorCode.VALIDATION.code,
            message:
              req.method === 'DELETE'
                ? '还有其他数据关联着它，不能删除。请先处理这些关联数据。'
                : '关联的数据不存在或已被删除，请刷新后重试',
          });
          return;
        case 'P2025': // 目标记录不存在
          res.status(200).json(ErrorCode.NOT_FOUND);
          return;
        default:
          break; // 其余仍走下面的兜底，避免把未知问题伪装成参数错误
      }
    }

    /*
     * 日志也要脱敏。
     *
     * 全库有一套很扎实的脱敏器（audit.service 的 redactString，覆盖
     * openid/手机号/token/私钥/JWT 形态），审计、告警、幂等记录都用了，而应用日志这条路径原先漏了——现已接上，下面这行即是
     * 这条路径没用。而落到这里的典型异常是 PrismaClientValidationError /
     * PrismaClientUnknownRequestError，Prisma 会把**完整调用参数**拼进 message：
     * wxUser.upsert 的 openid、adminUser.create 的 passwordHash、房屋的 ownerPhone
     * 都会原样进容器日志，被运维、日志采集侧、云控制台看到。
     *
     * 截到 4000 字符：Prisma 的校验错误 message 可以有上万字符（会把整个 schema 的
     * 字段列表贴出来），完整打印只会把有用的头部冲掉。
     */
    this.logger.error(
      redactAndTruncateText(exception instanceof Error ? (exception.stack ?? exception.message) : exception, 4000),
    );
    res.status(200).json(ErrorCode.INTERNAL);
  }
}
