/**
 * 微信能力抽象（spec §6.5）。
 * WX_MODE=mock：本地/测试全流程可跑；WX_MODE=real：真实微信接口（子项目5完善）。
 */

export interface SubscribeMessage {
  openid: string;
  templateType: 'BILL_CREATED' | 'DUE_SOON' | 'OVERDUE';
  data: Record<string, string>;
}

export interface WxApi {
  /** 小程序 wx.login 的 code 换 openid */
  code2session(code: string): Promise<{ openid: string }>;
  /** 手机号快速验证组件的 code 换手机号 */
  getPhoneNumber(code: string): Promise<{ phone: string }>;
  /** 发送订阅消息 */
  sendSubscribeMessage(msg: SubscribeMessage): Promise<{ ok: boolean; error?: string }>;
}

export const WX_API = Symbol('WX_API');
