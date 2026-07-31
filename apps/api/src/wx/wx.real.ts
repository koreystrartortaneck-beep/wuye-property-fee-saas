import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { SubscribeMessage, WxApi } from './wx.service';
import { WxCloudService } from './wx-cloud.service';
import { wxApiUrl } from './wx-endpoint';

/**
 * 真实微信实现（WX_MODE=real）。
 * 依赖：WX_APPID / WX_SECRET；订阅消息模板 ID 由环境变量提供：
 *   WX_TMPL_BILL_CREATED / WX_TMPL_DUE_SOON / WX_TMPL_OVERDUE
 * 订阅消息跳转页 WX_SUBSCRIBE_PAGE（默认账单页）。
 */
/**
 * 订阅消息错误码转人话。
 *
 * 微信原文会误导运维：43101 的 errmsg 是 "user refuse to accept the msg"，
 * 看起来像「业主拒收」，实际最常见的原因是**一次性订阅的额度用完了**——
 * 业主授权一次只能收一条，收过就没了。物业看到「拒收」会以为业主关了通知，
 * 从而放弃催缴，而真相是需要引导业主再授权一次。
 *
 * 保留原始 errcode 便于排查，同时给出中文解释与处置方向。
 */
function describeSubscribeError(errcode: number, errmsg?: string): string {
  const raw = `${errcode} ${errmsg ?? ''}`.trim();
  const explain: Record<number, string> = {
    43101: '业主没有可用的订阅额度（一次性订阅：授权一次只能收一条），需引导业主在小程序「我的 → 缴费提醒」再次授权',
    43102: '模板类型不匹配：该模板不是一次性订阅模板',
    43104: '模板 ID 不属于本小程序，检查 WX_TMPL_* 环境变量',
    47003: '模板参数不合法：字段名或取值格式与模板不符',
    40003: 'openid 无效，该业主的绑定可能已失效',
    45009: '接口调用超过频率限制',
  };
  const hint = explain[errcode];
  return hint ? `${hint}（微信原文：${raw}）` : raw;
}

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
    const url = wxApiUrl(
      `/sns/jscode2session?appid=${this.appId}&secret=${this.secret}`
        + `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`,
    );
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
    const res = await fetch(wxApiUrl(`/wxa/business/getuserphonenumber?access_token=${token}`), {
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
      /*
       * 微信要求 data 每字段包成 { value }。
       *
       * 截断必须按字段类型区分：thing / phrase 类限 20 字，超了会被判非法，
       * 所以做防御性截断；但 amount / time / date / character_string 类**绝不能**截断——
       * 原实现无差别 slice(0, 20)，一旦金额或日期文本偏长就会被静默改写，
       * 业主收到的金额与账单不一致，而日志只会记一句成功。
       */
      const data: Record<string, { value: string }> = {};
      for (const [k, v] of Object.entries(msg.data)) {
        const text = String(v ?? '');
        const truncatable = /^(thing|phrase)\d*$/.test(k);
        data[k] = { value: truncatable ? text.slice(0, 20) : text };
      }
      const res = await fetch(wxApiUrl(`/cgi-bin/message/subscribe/send?access_token=${token}`), {
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
        return { ok: false, error: describeSubscribeError(out.errcode, out.errmsg) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
