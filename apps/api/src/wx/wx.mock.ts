import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { SubscribeMessage, WxApi } from './wx.service';

/**
 * Mock 微信实现（WX_MODE=mock）。
 * 约定：code 前缀 `mock:` → openid；`phone:` → 明文手机号。
 */
@Injectable()
export class MockWxService implements WxApi {
  private readonly logger = new Logger('MockWx');

  async code2session(code: string): Promise<{ openid: string }> {
    if (!code.startsWith('mock:')) {
      throw new BizException(ErrorCode.VALIDATION, 'mock 模式下 code 须为 mock:<openid>');
    }
    return { openid: code.slice('mock:'.length) };
  }

  async getPhoneNumber(code: string): Promise<{ phone: string }> {
    if (!code.startsWith('phone:')) {
      throw new BizException(ErrorCode.VALIDATION, 'mock 模式下 code 须为 phone:<手机号>');
    }
    return { phone: code.slice('phone:'.length) };
  }

  async sendSubscribeMessage(msg: SubscribeMessage): Promise<{ ok: boolean }> {
    this.logger.log(`[mock 订阅消息] ${msg.openid} ${msg.templateType} ${JSON.stringify(msg.data)}`);
    return { ok: true };
  }
}
