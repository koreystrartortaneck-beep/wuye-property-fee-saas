import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { SubscribeMessage, WxApi } from './wx.service';

/**
 * 真实微信实现占位（WX_MODE=real，子项目 5 完善）。
 * 需要 WX_APPID / WX_SECRET 以及订阅消息模板 ID。
 */
@Injectable()
export class RealWxService implements WxApi {
  async code2session(_code: string): Promise<{ openid: string }> {
    throw new BizException(ErrorCode.INTERNAL, 'real 微信模式尚未配置（子项目5）');
  }

  async getPhoneNumber(_code: string): Promise<{ phone: string }> {
    throw new BizException(ErrorCode.INTERNAL, 'real 微信模式尚未配置（子项目5）');
  }

  async sendSubscribeMessage(_msg: SubscribeMessage): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'real 微信模式尚未配置' };
  }
}
