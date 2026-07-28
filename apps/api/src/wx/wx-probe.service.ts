import { Injectable } from '@nestjs/common';

/**
 * 微信开放接口连通性探测。
 *
 * 起因：订阅消息下发稳定失败于 `fetch failed`（8/8 全部如此）——这是网络层错误，
 * 不是微信业务错误，管理端只看到这四个字，无从判断是「域名不可达」「TLS 失败」
 * 还是「凭据不对」。而微信支付的 api.mch.weixin.qq.com 明明是通的（对账能下载
 * 账单），所以不能简单归因为「容器没有公网出口」。
 *
 * 微信云托管对 api.weixin.qq.com 有一层「开放接口服务」代理：开通后容器内可免鉴权
 * 调用，但走的是 **HTTP**；若代理生效而代码用 HTTPS，TLS 握手失败就表现为
 * fetch failed。是否如此必须实测，所以这里把两种传输方式都探一遍，把结论摆到界面上。
 *
 * 探测刻意做得很轻：只打 cgi-bin/token，短超时，绝不抛错。
 */

export interface WxProbeResult {
  /** 探测目标的可读名称 */
  name: string;
  /** 实际请求的 URL（密钥已打码） */
  url: string;
  ok: boolean;
  /** HTTP 状态码；网络层失败时为 null */
  httpStatus: number | null;
  /** 微信业务错误码/错误信息，或网络层错误信息 */
  detail: string;
  elapsedMs: number;
}

const TIMEOUT_MS = 6000;

function mask(url: string): string {
  return url.replace(/(secret=)[^&]*/i, '$1***');
}

@Injectable()
export class WxProbeService {
  private get appId() {
    return process.env.WX_APPID || '';
  }
  private get secret() {
    return process.env.WX_SECRET || '';
  }

  /**
   * 依次探测两种传输方式，返回两条结果。
   * 结论怎么读：
   *   - 只有 HTTPS 成功 → 直连模式可用，保持现状；
   *   - 只有 HTTP 成功  → 云托管开放接口代理生效，必须改用 HTTP 且不带 access_token；
   *   - 两个都失败      → 容器到 api.weixin.qq.com 不通，或开放接口服务未开通。
   */
  async probe(): Promise<{ appIdConfigured: boolean; secretConfigured: boolean; probes: WxProbeResult[] }> {
    const probes: WxProbeResult[] = [];

    // ① 直连：HTTPS + appid/secret 换 access_token（当前代码走的路径）
    probes.push(
      await this.once(
        '直连 HTTPS（当前代码路径）',
        `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.secret}`,
      ),
    );

    // ② 云托管开放接口代理：HTTP，免鉴权（不带 appid/secret）
    probes.push(
      await this.once(
        '云托管开放接口 HTTP（免鉴权）',
        'http://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential',
      ),
    );

    return {
      appIdConfigured: Boolean(this.appId),
      secretConfigured: Boolean(this.secret),
      probes,
    };
  }

  private async once(name: string, url: string): Promise<WxProbeResult> {
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      let detail = text.slice(0, 200);
      let ok = res.ok;
      try {
        const body = JSON.parse(text) as { access_token?: string; errcode?: number; errmsg?: string };
        if (body.access_token) {
          ok = true;
          detail = '成功取得 access_token';
        } else {
          ok = false;
          detail = `errcode=${body.errcode ?? '?'} ${body.errmsg ?? ''}`.trim();
        }
      } catch {
        // 非 JSON 响应（例如代理返回的错误页），保留原文前 200 字
        ok = false;
      }
      return { name, url: mask(url), ok, httpStatus: res.status, detail, elapsedMs: Date.now() - started };
    } catch (error) {
      // 网络层失败：把 cause.code（ENOTFOUND / ECONNREFUSED / EPROTO 等）带出来，
      // 光有一句 fetch failed 无法判断到底是哪一层的问题。
      const cause = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
      const code =
        cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : '';
      const message = error instanceof Error ? error.message : String(error);
      return {
        name,
        url: mask(url),
        ok: false,
        httpStatus: null,
        detail: code ? `${message}（${code}）` : message,
        elapsedMs: Date.now() - started,
      };
    }
  }
}
