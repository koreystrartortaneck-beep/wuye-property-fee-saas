// 统一业务错误码（spec §7）
// HTTP 始终 200，业务状态由 code 表达；code=0 为成功

export interface ErrorCodeDef {
  code: number;
  message: string;
}

export const ErrorCode = {
  OK: { code: 0, message: 'ok' },

  // 40xxx 通用
  VALIDATION: { code: 40000, message: '参数校验失败' },
  UNAUTHORIZED: { code: 40100, message: '未登录或登录已过期' },
  FORBIDDEN: { code: 40300, message: '无权限访问' },
  NOT_FOUND: { code: 40400, message: '资源不存在' },

  // 41xxx 用户与绑定
  NO_BINDING: { code: 41001, message: '未绑定该房屋' },
  BINDING_EXISTS: { code: 41002, message: '已绑定或已申请该房屋' },
  PHONE_REQUIRED: { code: 41003, message: '请先完成手机号授权' },

  // 42xxx 计费配置
  RULE_PARAM_INVALID: { code: 42001, message: '收费规则参数不合法' },
  METER_READING_BACKWARD: { code: 42002, message: '本期读数不能小于上期读数' },
  METER_READING_MISSING: { code: 42003, message: '缺少本期抄表读数' },
  SHARE_POOL_MISSING: { code: 42004, message: '缺少本期公摊总额' },
  FORMULA_INVALID: { code: 42005, message: '自定义公式不合法' },

  // 43xxx 账单与支付
  BILL_NOT_PAYABLE: { code: 43001, message: '账单不可支付' },
  PAYMENT_STATE_INVALID: { code: 43002, message: '订单状态不允许该操作' },

  // 44xxx 工单与访客
  TICKET_STATE_INVALID: { code: 44001, message: '工单状态不允许该操作' },
  PASS_STATE_INVALID: { code: 44002, message: '通行码状态不允许该操作' },
  UPLOAD_INVALID: { code: 44003, message: '文件类型或大小不符合要求' },

  // 50xxx
  INTERNAL: { code: 50000, message: '服务器内部错误' },
} as const satisfies Record<string, ErrorCodeDef>;

export type ErrorCodeKey = keyof typeof ErrorCode;
