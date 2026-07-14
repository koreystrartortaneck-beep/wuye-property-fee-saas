import { Injectable, Logger } from '@nestjs/common';

/**
 * 微信云存储辅助：把小程序上传得到的 cloud:// fileID 解析成浏览器可访问的临时 https URL，
 * 供管理后台（Web）展示业主上传的工单图片。
 *
 * 依赖环境变量：WX_APPID / WX_SECRET（换 access_token）、WX_CLOUD_ENV（云环境ID）。
 * 注意：调用 cgi-bin/token 的服务器出口 IP 需在小程序「IP白名单」内（若开启了该校验）。
 */
@Injectable()
export class WxCloudService {
  private readonly logger = new Logger(WxCloudService.name);
  private tokenCache: { token: string; exp: number } | null = null;

  private get appId() {
    return process.env.WX_APPID || '';
  }
  private get secret() {
    return process.env.WX_SECRET || '';
  }
  private get env() {
    return process.env.WX_CLOUD_ENV || '';
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.exp > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.secret}`;
    const res = await fetch(url);
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
    if (!data.access_token) {
      throw new Error(`获取 access_token 失败：${data.errmsg || 'unknown'}`);
    }
    this.tokenCache = {
      token: data.access_token,
      exp: Date.now() + ((data.expires_in || 7200) - 300) * 1000,
    };
    return data.access_token;
  }

  /** cloud:// fileID[] → { fileID: 临时URL }。非 cloud:// 的原样忽略；失败返回空映射（前端各自兜底）。 */
  async resolveFileUrls(fileIds: string[]): Promise<Record<string, string>> {
    const cloudIds = [...new Set((fileIds || []).filter((f) => typeof f === 'string' && f.startsWith('cloud://')))];
    if (cloudIds.length === 0 || !this.env || !this.appId || !this.secret) return {};
    try {
      const token = await this.getAccessToken();
      const res = await fetch(`https://api.weixin.qq.com/tcb/batchdownloadfile?access_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          env: this.env,
          file_list: cloudIds.map((fileid) => ({ fileid, max_age: 7200 })),
        }),
      });
      const data = (await res.json()) as {
        file_list?: Array<{ fileid: string; download_url?: string; status?: number }>;
      };
      const out: Record<string, string> = {};
      for (const it of data.file_list || []) {
        if (it.download_url) out[it.fileid] = it.download_url;
      }
      return out;
    } catch (e) {
      this.logger.warn(`解析云存储文件失败：${(e as Error).message}`);
      return {};
    }
  }
}
