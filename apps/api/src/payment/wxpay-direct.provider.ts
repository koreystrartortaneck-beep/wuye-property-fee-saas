import { Injectable } from '@nestjs/common';
import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CreateOrderInput, PaymentProvider, PaymentProviderError, WxPayTransaction } from './provider';

export type { WxPayTransaction } from './provider';

export type WxPayNotificationHeaders = Record<string, string | string[] | undefined>;

interface WxPayConfig {
  appId: string;
  mchId: string;
  apiV3Key: Buffer;
  merchantSerial: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyId: string;
  notifyUrl: string;
}

interface EncryptedResource {
  algorithm: string;
  ciphertext: string;
  nonce: string;
  associated_data?: string;
}

interface NotificationEnvelope {
  event_type?: string;
  resource?: EncryptedResource;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`微信支付配置缺失：${name}`);
  return value;
}

function loadPem(valueName: string, pathName: string): string {
  const inline = process.env[valueName];
  if (inline) return inline.replace(/\\n/g, '\n');
  const filePath = process.env[pathName];
  if (!filePath) throw new Error(`微信支付配置缺失：${valueName} 或 ${pathName}`);
  return readFileSync(resolve(filePath), 'utf8');
}

function headerValue(headers: WxPayNotificationHeaders, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

@Injectable()
export class WxPayDirectProvider implements PaymentProvider {
  private readonly baseUrl = 'https://api.mch.weixin.qq.com';
  private cachedConfig?: WxPayConfig;

  assertConfigured(): void {
    this.config();
  }

  private config(): WxPayConfig {
    if (this.cachedConfig) return this.cachedConfig;
    const apiV3Key = Buffer.from(required('WX_PAY_API_V3_KEY'), 'utf8');
    if (apiV3Key.length !== 32) throw new Error('WX_PAY_API_V3_KEY 必须是 32 字节');

    const notifyUrl = required('WX_PAY_NOTIFY_URL');
    if (!notifyUrl.startsWith('https://')) throw new Error('WX_PAY_NOTIFY_URL 必须使用 HTTPS');

    this.cachedConfig = {
      appId: required('WX_PAY_APP_ID', process.env.WX_APPID),
      mchId: required('WX_PAY_MCH_ID'),
      apiV3Key,
      merchantSerial: required('WX_PAY_MERCHANT_SERIAL'),
      privateKey: createPrivateKey(loadPem('WX_PAY_PRIVATE_KEY', 'WX_PAY_PRIVATE_KEY_PATH')),
      publicKey: createPublicKey(loadPem('WX_PAY_PUBLIC_KEY', 'WX_PAY_PUBLIC_KEY_PATH')),
      publicKeyId: required('WX_PAY_PUBLIC_KEY_ID'),
      notifyUrl,
    };
    return this.cachedConfig;
  }

  async createOrder(input: CreateOrderInput): Promise<Record<string, string>> {
    if (!input.payerOpenid) throw new Error('真实支付缺少付款人 OpenID');
    if (!Number.isInteger(input.totalCents) || input.totalCents <= 0) throw new Error('支付金额必须为正整数分');

    const config = this.config();
    const body = {
      appid: config.appId,
      mchid: config.mchId,
      description: input.description.slice(0, 127),
      out_trade_no: input.orderNo,
      attach: input.tenantId,
      notify_url: config.notifyUrl,
      amount: { total: input.totalCents, currency: 'CNY' },
      payer: { openid: input.payerOpenid },
    };
    const result = await this.request<{ prepay_id: string }>('POST', '/v3/pay/transactions/jsapi', body, config);
    if (!result.prepay_id) throw new Error('微信支付预下单响应缺少 prepay_id');

    const timeStamp = String(Math.floor(Date.now() / 1000));
    const nonceStr = randomBytes(16).toString('hex');
    const packageValue = `prepay_id=${result.prepay_id}`;
    const paySign = sign(
      'RSA-SHA256',
      Buffer.from(`${config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`),
      config.privateKey,
    ).toString('base64');

    return { timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign };
  }

  async queryOrder(orderNo: string): Promise<WxPayTransaction> {
    const config = this.config();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(config.mchId)}`;
    return this.request<WxPayTransaction>('GET', path, undefined, config);
  }

  async close(orderNo: string): Promise<void> {
    const config = this.config();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`;
    await this.request<Record<string, never>>('POST', path, { mchid: config.mchId }, config);
  }

  parseNotification(headers: WxPayNotificationHeaders, rawBody: Buffer): WxPayTransaction {
    const config = this.config();
    const timestamp = headerValue(headers, 'wechatpay-timestamp');
    const nonce = headerValue(headers, 'wechatpay-nonce');
    const serial = headerValue(headers, 'wechatpay-serial');
    const signature = headerValue(headers, 'wechatpay-signature');
    if (!timestamp || !nonce || !serial || !signature) throw new Error('微信支付回调签名头不完整');

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
      throw new Error('微信支付回调时间戳无效');
    }
    if (serial !== config.publicKeyId) throw new Error('微信支付回调公钥 ID 不匹配');

    const message = Buffer.from(`${timestamp}\n${nonce}\n${rawBody.toString('utf8')}\n`);
    if (!verify('RSA-SHA256', message, config.publicKey, Buffer.from(signature, 'base64'))) {
      throw new Error('微信支付回调验签失败');
    }

    const envelope = JSON.parse(rawBody.toString('utf8')) as NotificationEnvelope;
    if (envelope.event_type !== 'TRANSACTION.SUCCESS' || !envelope.resource) {
      throw new Error(`不支持的微信支付回调事件：${envelope.event_type || 'unknown'}`);
    }
    if (envelope.resource.algorithm !== 'AEAD_AES_256_GCM') throw new Error('微信支付回调加密算法不支持');

    const transaction = this.decryptResource(envelope.resource, config.apiV3Key);
    if (transaction.appid !== config.appId) throw new Error('微信支付回调 AppID 不匹配');
    if (transaction.mchid !== config.mchId) throw new Error('微信支付回调商户号不匹配');
    if (transaction.trade_state !== 'SUCCESS') throw new Error(`微信支付状态不是 SUCCESS：${transaction.trade_state}`);
    return transaction;
  }

  private decryptResource(resource: EncryptedResource, key: Buffer): WxPayTransaction {
    const encrypted = Buffer.from(resource.ciphertext, 'base64');
    if (encrypted.length <= 16) throw new Error('微信支付回调密文无效');
    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const authTag = encrypted.subarray(encrypted.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce));
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associated_data || ''));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as WxPayTransaction;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body: unknown, config: WxPayConfig): Promise<T> {
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${bodyText}\n`),
      config.privateKey,
    ).toString('base64');
    const authorization = 'WECHATPAY2-SHA256-RSA2048 '
      + `mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",`
      + `serial_no="${config.merchantSerial}",signature="${signature}"`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authorization,
        'Wechatpay-Serial': config.publicKeyId,
      },
      body: body === undefined ? undefined : bodyText,
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = await response.text();
    this.verifyResponse(response.headers, responseBody, config);

    if (!response.ok) {
      let code = 'UNKNOWN';
      let message = responseBody || '无响应内容';
      try {
        const parsed = JSON.parse(responseBody) as { code?: string; message?: string };
        code = parsed.code || code;
        message = parsed.message || message;
      } catch {
        // Preserve the raw response for non-JSON gateway errors.
      }
      throw new PaymentProviderError(response.status, code, `微信支付接口失败：${code}: ${message}`);
    }
    if (!responseBody) return {} as T;
    return JSON.parse(responseBody) as T;
  }

  private verifyResponse(headers: Headers, body: string, config: WxPayConfig): void {
    const timestamp = headers.get('Wechatpay-Timestamp') || '';
    const nonce = headers.get('Wechatpay-Nonce') || '';
    const serial = headers.get('Wechatpay-Serial') || '';
    const signature = headers.get('Wechatpay-Signature') || '';
    if (!timestamp || !nonce || !serial || !signature) throw new Error('微信支付应答签名头不完整');
    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
      throw new Error('微信支付应答时间戳无效');
    }
    if (serial !== config.publicKeyId) throw new Error('微信支付应答公钥 ID 不匹配');
    const message = Buffer.from(`${timestamp}\n${nonce}\n${body}\n`);
    if (!verify('RSA-SHA256', message, config.publicKey, Buffer.from(signature, 'base64'))) {
      throw new Error('微信支付应答验签失败');
    }
  }
}
