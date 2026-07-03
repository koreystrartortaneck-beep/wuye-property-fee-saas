import { ErrorCodeDef } from '@pf/shared';

/** 业务异常：携带统一错误码，由全局过滤器转为 {code,message} 响应 */
export class BizException extends Error {
  readonly code: number;

  constructor(def: ErrorCodeDef, extra?: string) {
    super(extra ? `${def.message}：${extra}` : def.message);
    this.code = def.code;
  }
}
