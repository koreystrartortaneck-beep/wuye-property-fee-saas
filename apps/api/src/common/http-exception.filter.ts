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
import { Response } from 'express';
import { ErrorCode } from '@pf/shared';
import { BizException } from './biz.exception';
import { Prisma } from '@prisma/client';

/**
 * 全局异常 → 统一 {code,message} 响应，HTTP 始终 200（spec §7）。
 * 未知异常记日志并返回 50000，不泄漏堆栈。
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
      res.status(200).json(ErrorCode.NOT_FOUND);
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
        case 'P2003': // 外键约束失败
          res.status(200).json({
            code: ErrorCode.VALIDATION.code,
            message: '关联的数据不存在或已被删除，请刷新后重试',
          });
          return;
        case 'P2025': // 目标记录不存在
          res.status(200).json(ErrorCode.NOT_FOUND);
          return;
        default:
          break; // 其余仍走下面的兜底，避免把未知问题伪装成参数错误
      }
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(200).json(ErrorCode.INTERNAL);
  }
}
