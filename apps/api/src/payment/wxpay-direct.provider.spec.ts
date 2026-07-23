import {
  createCipheriv,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { WxPayDirectProvider } from './wxpay-direct.provider';

const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wechatPayKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPrivateKey = merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const merchantPublicKey = merchantKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const wechatPayPrivateKey = wechatPayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const wechatPayPublicKey = wechatPayKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedResponse(body: string, status = 200, timestamp = String(Math.floor(Date.now() / 1000))): Response {
  const nonce = randomBytes(12).toString('hex');
  const signature = sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), wechatPayPrivateKey).toString('base64');
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Wechatpay-Timestamp': timestamp,
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Serial': process.env.WX_PAY_PUBLIC_KEY_ID!,
      'Wechatpay-Signature': signature,
    },
  });
}

function encryptResource(data: unknown, nonce: string, associatedData: string): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.WX_PAY_API_V3_KEY!), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64');
}

describe('WxPayDirectProvider', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.WX_PAY_APP_ID = 'wx-test-appid';
    process.env.WX_PAY_MCH_ID = '1900000109';
    process.env.WX_PAY_API_V3_KEY = '0123456789abcdef0123456789abcdef';
    process.env.WX_PAY_MERCHANT_SERIAL = 'MERCHANT-SERIAL';
    process.env.WX_PAY_PRIVATE_KEY = merchantPrivateKey;
    process.env.WX_PAY_PUBLIC_KEY = wechatPayPublicKey;
    process.env.WX_PAY_PUBLIC_KEY_ID = 'PUB_KEY_ID_TEST';
    process.env.WX_PAY_NOTIFY_URL = 'https://example.com/api/v1/payment/wxpay/notify';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('签名预下单请求、验签微信应答并生成可验证的小程序支付参数', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = String(init?.body ?? '');
      const authorization = new Headers(init?.headers).get('Authorization')!;
      const fields = Object.fromEntries(
        [...authorization.matchAll(/([a-z_]+)="([^"]+)"/g)].map((match) => [match[1], match[2]]),
      );
      const message = `${init?.method}\n${url.pathname}${url.search}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`;
      expect(fields.mchid).toBe(process.env.WX_PAY_MCH_ID);
      expect(fields.serial_no).toBe(process.env.WX_PAY_MERCHANT_SERIAL);
      expect(verify('RSA-SHA256', Buffer.from(message), merchantPublicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);

      const requestBody = JSON.parse(body) as Record<string, unknown>;
      expect(requestBody).toMatchObject({
        appid: process.env.WX_PAY_APP_ID,
        mchid: process.env.WX_PAY_MCH_ID,
        out_trade_no: 'WY20260722000001',
        notify_url: process.env.WX_PAY_NOTIFY_URL,
        amount: { total: 1, currency: 'CNY' },
        payer: { openid: 'openid-1' },
      });
      return signedResponse(JSON.stringify({ prepay_id: 'wx-prepay-id' }));
    }) as typeof fetch;

    const result = await new WxPayDirectProvider().createOrder({
      orderNo: 'WY20260722000001',
      totalCents: 1,
      description: '物业费',
      payerOpenid: 'openid-1',
      tenantId: 'tenant-1',
    });

    expect(result).toMatchObject({ package: 'prepay_id=wx-prepay-id', signType: 'RSA' });
    const message = `${process.env.WX_PAY_APP_ID}\n${result.timeStamp}\n${result.nonceStr}\n${result.package}\n`;
    expect(verify('RSA-SHA256', Buffer.from(message), merchantPublicKey, Buffer.from(String(result.paySign), 'base64'))).toBe(true);
  });

  it('拒绝微信支付错误签名的应答', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ prepay_id: 'wx-prepay-id' }), {
        status: 200,
        headers: {
          'Wechatpay-Timestamp': String(Math.floor(Date.now() / 1000)),
          'Wechatpay-Nonce': 'nonce',
          'Wechatpay-Serial': process.env.WX_PAY_PUBLIC_KEY_ID!,
          'Wechatpay-Signature': Buffer.from('invalid').toString('base64'),
        },
      }),
    ) as typeof fetch;

    await expect(new WxPayDirectProvider().createOrder({
      orderNo: 'WY20260722000002',
      totalCents: 1,
      description: '物业费',
      payerOpenid: 'openid-1',
      tenantId: 'tenant-1',
    })).rejects.toThrow('微信支付应答验签失败');
  });

  it('拒绝超过五分钟的微信支付应答', async () => {
    const body = JSON.stringify({ prepay_id: 'wx-prepay-id' });
    global.fetch = jest.fn().mockResolvedValue(
      signedResponse(body, 200, String(Math.floor(Date.now() / 1000) - 301)),
    ) as typeof fetch;

    await expect(new WxPayDirectProvider().createOrder({
      orderNo: 'WY20260722000004',
      totalCents: 1,
      description: '物业费',
      payerOpenid: 'openid-1',
      tenantId: 'tenant-1',
    })).rejects.toThrow('微信支付应答时间戳无效');
  });

  it('验签并解密支付成功回调', () => {
    const transaction = {
      appid: process.env.WX_PAY_APP_ID,
      mchid: process.env.WX_PAY_MCH_ID,
      out_trade_no: 'WY20260722000003',
      transaction_id: '4200000000001',
      trade_state: 'SUCCESS',
      success_time: '2026-07-22T10:00:00+08:00',
      amount: { total: 1, payer_total: 1, currency: 'CNY' },
    };
    const resourceNonce = '0123456789ab';
    const associatedData = 'transaction';
    const body = JSON.stringify({
      id: 'event-id',
      event_type: 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        nonce: resourceNonce,
        associated_data: associatedData,
        ciphertext: encryptResource(transaction, resourceNonce, associatedData),
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'callback-nonce';
    const signature = sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), wechatPayPrivateKey).toString('base64');

    const result = new WxPayDirectProvider().parseNotification({
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-serial': process.env.WX_PAY_PUBLIC_KEY_ID!,
      'wechatpay-signature': signature,
    }, Buffer.from(body));

    expect(result).toEqual(transaction);
  });

  it('拒绝超出五分钟时间窗的回调', () => {
    const body = Buffer.from('{}');
    expect(() => new WxPayDirectProvider().parseNotification({
      'wechatpay-timestamp': String(Math.floor(Date.now() / 1000) - 301),
      'wechatpay-nonce': 'nonce',
      'wechatpay-serial': process.env.WX_PAY_PUBLIC_KEY_ID!,
      'wechatpay-signature': 'invalid',
    }, body)).toThrow('微信支付回调时间戳无效');
  });

  it('签名申请退款、验签应答并返回退款结果', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.method).toBe('POST');
      expect(url.pathname).toBe('/v3/refund/domestic/refunds');
      const authorization = new Headers(init?.headers).get('Authorization')!;
      const fields = Object.fromEntries(
        [...authorization.matchAll(/([a-z_]+)="([^"]+)"/g)].map((match) => [match[1], match[2]]),
      );
      const body = String(init?.body ?? '');
      const message = `${init?.method}\n${url.pathname}${url.search}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`;
      expect(verify('RSA-SHA256', Buffer.from(message), merchantPublicKey, Buffer.from(fields.signature, 'base64'))).toBe(true);
      expect(JSON.parse(body)).toMatchObject({
        out_trade_no: 'WY20260722000001',
        out_refund_no: 'RF-WY20260722000001',
        amount: { refund: 1, total: 1, currency: 'CNY' },
      });
      return signedResponse(JSON.stringify({
        refund_id: '50000000001',
        out_refund_no: 'RF-WY20260722000001',
        out_trade_no: 'WY20260722000001',
        transaction_id: '4200000000001',
        status: 'SUCCESS',
        amount: { total: 1, refund: 1, currency: 'CNY' },
      }));
    }) as typeof fetch;

    const result = await new WxPayDirectProvider().createRefund({
      outTradeNo: 'WY20260722000001',
      outRefundNo: 'RF-WY20260722000001',
      totalCents: 1,
      refundCents: 1,
      reason: '业主申请全额退款',
      tenantId: 'tenant-1',
    });
    expect(result).toMatchObject({ refund_id: '50000000001', status: 'SUCCESS' });
  });

  it('拒绝退款金额非法（大于原额或非正整数）', async () => {
    global.fetch = jest.fn() as typeof fetch;
    await expect(new WxPayDirectProvider().createRefund({
      outTradeNo: 'WY1', outRefundNo: 'RF-WY1', totalCents: 1, refundCents: 2, reason: 'x', tenantId: 't',
    })).rejects.toThrow('退款金额');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('查询退款单', async () => {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.method).toBe('GET');
      expect(url.pathname).toBe('/v3/refund/domestic/refunds/RF-WY20260722000001');
      return signedResponse(JSON.stringify({
        refund_id: '50000000001', out_refund_no: 'RF-WY20260722000001',
        status: 'PROCESSING', amount: { total: 1, refund: 1 },
      }));
    }) as typeof fetch;
    const result = await new WxPayDirectProvider().queryRefund('RF-WY20260722000001');
    expect(result.status).toBe('PROCESSING');
  });

  it('验签并解密退款成功回调', () => {
    const refund = {
      mchid: process.env.WX_PAY_MCH_ID,
      out_trade_no: 'WY20260722000001',
      transaction_id: '4200000000001',
      out_refund_no: 'RF-WY20260722000001',
      refund_id: '50000000001',
      refund_status: 'SUCCESS',
      success_time: '2026-07-22T10:05:00+08:00',
      amount: { total: 1, refund: 1, payer_total: 1, payer_refund: 1 },
    };
    const resourceNonce = '0123456789ab';
    const associatedData = 'refund';
    const body = JSON.stringify({
      id: 'evt-refund',
      event_type: 'REFUND.SUCCESS',
      resource_type: 'encrypt-resource',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        nonce: resourceNonce,
        associated_data: associatedData,
        ciphertext: encryptResource(refund, resourceNonce, associatedData),
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'refund-nonce';
    const signature = sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), wechatPayPrivateKey).toString('base64');

    const result = new WxPayDirectProvider().parseRefundNotification({
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-serial': process.env.WX_PAY_PUBLIC_KEY_ID!,
      'wechatpay-signature': signature,
    }, Buffer.from(body));

    expect(result).toMatchObject({
      out_refund_no: 'RF-WY20260722000001',
      status: 'SUCCESS',
      amount: { refund: 1, total: 1 },
    });
  });

  it('退款回调公钥 ID 不匹配时拒绝', () => {
    expect(() => new WxPayDirectProvider().parseRefundNotification({
      'wechatpay-timestamp': String(Math.floor(Date.now() / 1000)),
      'wechatpay-nonce': 'nonce',
      'wechatpay-serial': 'WRONG_KEY_ID',
      'wechatpay-signature': 'x',
    }, Buffer.from('{}'))).toThrow('公钥 ID 不匹配');
  });
});
