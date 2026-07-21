import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { SubscribeMessage, WxApi } from './wx.service';
import { WxCloudService } from './wx-cloud.service';

/**
 * 真实微信实现（WX_MODE=real）。
 * 依赖：WX_APPID / WX_SECRET；订阅消息模板 ID 由环境变量提供：
 *   WX_TMPL_BILL_CREATED / WX_TMPL_DUE_SOON / WX_TMPL_OVERDUE
 * 订阅消息跳转页 WX_SUBSCRIBE_PAGE（默认账单页）。
 */
@Injectable()
export class RealWxService implements WxApi {
  constructor(private readonly wxCloud: WxCloudService) {}

  private get appId() {
    return process.env.WX_APPID || '';
  }
  private get secret() {
    return process.env.WX_SECRET || '';
  }

  private assertConfigured(): void {
    if (!this.appId || !this.secret) {
      throw new BizException(ErrorCode.INTERNAL, '微信 AppID 或 AppSecret 未配置');
    }
  }

  private networkErrorDetail(error: unknown): string {
    const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
    if (cause && typeof cause === 'object' && 'code' in cause) {
      return String((cause as { code: unknown }).code);
    }
    return error instanceof Error ? error.message : 'unknown';
  }

  /** wx.login 的 code 换 openid */
  async code2session(code: string): Promise<{ openid: string }> {
    this.assertConfigured();
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${this.appId}&secret=${this.secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    let data: { openid?: string; session_key?: string; errcode?: number; errmsg?: string };
    try {
      const response = await fetch(url);
      data = (await response.json()) as typeof data;
    } catch (error) {
      throw new BizException(ErrorCode.INTERNAL, `微信登录接口请求失败（${this.networkErrorDetail(error)}）`);
    }
    if (!data.openid) {
      throw new BizException(ErrorCode.UNAUTHORIZED, `微信登录失败：${data.errmsg || data.errcode || 'unknown'}`);
    }
    return { openid: data.openid };
  }

  /** 手机号快速验证组件的 code 换手机号（新版 getPhoneNumber，button 返回 e.detail.code） */
  async getPhoneNumber(code: string): Promise<{ phone: string }> {
    const token = await this.wxCloud.getAccessToken();
    const res = await fetch(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json()) as {
      errcode?: number;
      errmsg?: string;
      phone_info?: { phoneNumber?: string; purePhoneNumber?: string };
    };
    const phone = data.phone_info?.purePhoneNumber || data.phone_info?.phoneNumber;
    if (data.errcode || !phone) {
      throw new BizException(ErrorCode.VALIDATION, `获取手机号失败：${data.errmsg || data.errcode || 'unknown'}`);
    }
    return { phone };
  }

  /** 发送订阅消息 */
  async sendSubscribeMessage(msg: SubscribeMessage): Promise<{ ok: boolean; error?: string }> {
    const templateId = process.env[`WX_TMPL_${msg.templateType}`] || '';
    if (!templateId) {
      return { ok: false, error: `未配置模板（设置环境变量 WX_TMPL_${msg.templateType}）` };
    }
    try {
      const token = await this.wxCloud.getAccessToken();
      // WeChat 要求 data 每字段包成 { value }；thing 类字段 ≤20 字，防御性截断
      const data: Record<string, { value: string }> = {};
      for (const [k, v] of Object.entries(msg.data)) {
        data[k] = { value: String(v ?? '').slice(0, 20) };
      }
      const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: msg.openid,
          template_id: templateId,
          page: process.env.WX_SUBSCRIBE_PAGE || 'pages/bill/bill',
          miniprogram_state: process.env.WX_SUBSCRIBE_STATE || 'formal',
          data,
        }),
      });
      const out = (await res.json()) as { errcode?: number; errmsg?: string };
      if (out.errcode && out.errcode !== 0) {
        return { ok: false, error: `${out.errcode} ${out.errmsg}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
