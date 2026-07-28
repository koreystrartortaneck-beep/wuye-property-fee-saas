import fs from 'node:fs';
import path from 'node:path';
import { wxApiBase, wxApiUrl } from './wx-endpoint';

/**
 * 起因（P0）：微信云托管对 api.weixin.qq.com 做了自签证书代理劫持，容器内发起
 * HTTPS 请求在 TLS 握手阶段就失败，Node 的 fetch 只给一句 `fetch failed`，
 * cause.code 才是真凶 DEPTH_ZERO_SELF_SIGNED_CERT。
 *
 * 线上实测（/admin/operations/wx-probe）：
 *   https://api.weixin.qq.com/cgi-bin/token → fetch failed（DEPTH_ZERO_SELF_SIGNED_CERT）
 *   http://api.weixin.qq.com/cgi-bin/token  → HTTP 200，微信真实响应（带 rid）
 *
 * 影响面远不止订阅消息：code2session（业主登录）、getuserphonenumber、
 * cgi-bin/token、tcb/*（云存储）全在这个域名下。也就是说业主登录一直是坏的，
 * 只因已登录用户 JWT 未过期才没被发现。
 *
 * 所以这里既测拼接逻辑，也做静态扫描：任何源码里再出现
 * https://api.weixin.qq.com 就直接失败。
 */
describe('微信开放接口基础地址', () => {
  const saved = process.env.WX_API_BASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.WX_API_BASE;
    else process.env.WX_API_BASE = saved;
  });

  it('默认走明文 HTTP —— 云托管里 HTTPS 是死路', () => {
    delete process.env.WX_API_BASE;
    expect(wxApiBase()).toBe('http://api.weixin.qq.com');
  });

  it('可用 WX_API_BASE 覆盖（云托管之外部署时改回 https）', () => {
    process.env.WX_API_BASE = 'https://api.weixin.qq.com';
    expect(wxApiUrl('/cgi-bin/token')).toBe('https://api.weixin.qq.com/cgi-bin/token');
  });

  it('末尾斜杠与缺失前导斜杠都能拼对，不产出 // 或粘连路径', () => {
    process.env.WX_API_BASE = 'http://example.test/';
    expect(wxApiUrl('/cgi-bin/token')).toBe('http://example.test/cgi-bin/token');
    expect(wxApiUrl('cgi-bin/token')).toBe('http://example.test/cgi-bin/token');
  });

  it('源码里不得再出现硬编码的 https://api.weixin.qq.com', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      // 探测服务的职责就是对比两种传输，必须保留 HTTPS 那一条作为对照
      if (name === 'wx-probe.service.ts' || name.endsWith('.spec.ts')) continue;
      const src = fs.readFileSync(path.join(dir, name), 'utf8');
      // 注释里可以提及，只有出现在代码（含反引号模板）里才算
      const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (withoutComments.includes('https://api.weixin.qq.com')) offenders.push(name);
    }
    if (offenders.length) {
      throw new Error(
        '以下文件硬编码了 https://api.weixin.qq.com，在云托管里必然 TLS 握手失败：\n  ' +
          offenders.join('\n  ') +
          '\n请改用 wxApiUrl()。',
      );
    }
    expect(offenders).toEqual([]);
  });

  it('微信支付域名不在劫持范围内，必须保持 HTTPS，不能被一起改掉', () => {
    const payProvider = fs.readFileSync(
      path.join(__dirname, '..', 'payment', 'wxpay-direct.provider.ts'),
      'utf8',
    );
    expect(payProvider).toContain("'https://api.mch.weixin.qq.com'");
  });
});
