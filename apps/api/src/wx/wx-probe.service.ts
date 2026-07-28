import { Injectable } from '@nestjs/common';
import { wxApiBase, wxApiUrl } from './wx-endpoint';

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
   *   - 只有 HTTPS 成功 → 不在云托管环境，WX_API_BASE 应设为 https://api.weixin.qq.com；
   *   - 只有 HTTP 成功  → 云托管代理生效（实测就是这种），WX_API_BASE 保持默认 http://；
   *   - 两个都失败      → 容器到 api.weixin.qq.com 不通，检查云托管公网出口。
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

    // ② 明文 HTTP（云托管代理的通路），带正常凭据
    probes.push(
      await this.once(
        '明文 HTTP + 凭据',
        `http://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.secret}`,
      ),
    );

    /*
     * ③ 当前代码实际使用的地址（WX_API_BASE，默认 http://api.weixin.qq.com）。
     * 前两条是诊断用的对照，这一条才是「线上到底能不能用」的答案——
     * 只看对照容易漏掉配置被改坏的情况。
     */
    probes.push(
      await this.once(
        `当前配置（WX_API_BASE=${wxApiBase()}）`,
        wxApiUrl(`/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.secret}`),
      ),
    );

    /*
     * ④ 登录路径单独探一次。
     *
     * sns/jscode2session 的路径前缀与 cgi-bin/* 不同，云托管代理未必按同样方式
     * 转发——只验证 cgi-bin 就断定「登录也通了」是想当然。这里用一个明知无效的
     * code 去打：只要微信回 40029 invalid code，就证明请求确实穿过代理到达了
     * 微信服务，登录链路的网络层是通的（业务上当然该失败）。
     */
    probes.push(
      await this.once(
        '业主登录路径 sns/jscode2session',
        wxApiUrl(
          `/sns/jscode2session?appid=${this.appId}&secret=${this.secret}`
            + '&js_code=probe-invalid-code&grant_type=authorization_code',
        ),
        // 40029 = code 无效，正是我们期望的「到达了微信」的证据
        [40029],
      ),
    );

    return {
      appIdConfigured: Boolean(this.appId),
      secretConfigured: Boolean(this.secret),
      probes,
    };
  }

  /**
   * @param expectedErrcodes 这些业务错误码视为「网络层通了」。
   *   例如探测登录路径时故意用无效 code，微信回 40029 恰好证明请求到达了微信。
   */
  private async once(name: string, url: string, expectedErrcodes: number[] = []): Promise<WxProbeResult> {
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
        } else if (body.errcode !== undefined && expectedErrcodes.includes(body.errcode)) {
          ok = true;
          detail = `已到达微信服务（errcode=${body.errcode} ${body.errmsg ?? ''}，这是探测用的无效参数所致）`.trim();
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
