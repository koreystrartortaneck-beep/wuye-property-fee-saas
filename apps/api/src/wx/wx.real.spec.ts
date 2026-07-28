import { ErrorCode } from '@pf/shared';
import { RealWxService } from './wx.real';
import { WxCloudService } from './wx-cloud.service';

describe('RealWxService', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WX_APPID;
    delete process.env.WX_SECRET;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('微信凭据缺失时拒绝登录且不发送请求', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ openid: 'should-not-be-used' }),
    });
    global.fetch = fetchMock as typeof fetch;
    const service = new RealWxService({} as WxCloudService);

    await expect(service.code2session('login-code')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL.code,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('微信凭据缺失时拒绝获取 access token 且不发送请求', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ access_token: 'should-not-be-used' }),
    });
    global.fetch = fetchMock as typeof fetch;
    const service = new WxCloudService();

    await expect(service.getAccessToken()).rejects.toThrow('微信 AppID 或 AppSecret 未配置');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('使用登录 code 换取 openid', async () => {
    process.env.WX_APPID = 'test-appid';
    process.env.WX_SECRET = 'test-secret';
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ openid: 'owner-openid', session_key: 'session-key' }),
    });
    global.fetch = fetchMock as typeof fetch;
    const service = new RealWxService({} as WxCloudService);

    await expect(service.code2session('code with spaces')).resolves.toEqual({ openid: 'owner-openid' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('js_code=code%20with%20spaces'));
  });

  it('微信拒绝登录 code 时返回未授权错误', async () => {
    process.env.WX_APPID = 'test-appid';
    process.env.WX_SECRET = 'test-secret';
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ errcode: 40029, errmsg: 'invalid code' }),
    }) as typeof fetch;
    const service = new RealWxService({} as WxCloudService);

    await expect(service.code2session('expired-code')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED.code,
      message: expect.stringContaining('invalid code'),
    });
  });

  it('微信登录网络失败时返回安全的底层错误码', async () => {
    process.env.WX_APPID = 'test-appid';
    process.env.WX_SECRET = 'test-secret';
    const networkError = new TypeError('fetch failed') as TypeError & { cause?: { code: string } };
    networkError.cause = { code: 'ENETUNREACH' };
    global.fetch = jest.fn().mockRejectedValue(networkError) as typeof fetch;
    const service = new RealWxService({} as WxCloudService);

    await expect(service.code2session('login-code')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL.code,
      message: expect.stringContaining('ENETUNREACH'),
    });
  });

  it('使用手机号授权 code 换取手机号', async () => {
    const wxCloud = { getAccessToken: jest.fn().mockResolvedValue('access-token') } as unknown as WxCloudService;
    const fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ errcode: 0, phone_info: { purePhoneNumber: '13800138000' } }),
    });
    global.fetch = fetchMock as typeof fetch;
    const service = new RealWxService(wxCloud);

    await expect(service.getPhoneNumber('phone-code')).resolves.toEqual({ phone: '13800138000' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('access_token=access-token'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'phone-code' }) }),
    );
  });

  it('未配置订阅模板时跳过且不获取 access token', async () => {
    const getAccessToken = jest.fn();
    const service = new RealWxService({ getAccessToken } as unknown as WxCloudService);

    await expect(
      service.sendSubscribeMessage({ openid: 'owner-openid', templateType: 'BILL_CREATED', data: {} }),
    ).resolves.toEqual({
      ok: false,
      error: '未配置模板（设置环境变量 WX_TMPL_BILL_CREATED）',
    });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  /**
   * 截断必须按字段类型区分。
   *
   * 原实现对 data 的每个字段无差别 slice(0, 20)：thing/phrase 类确实限 20 字，
   * 但 amount / time / date / character_string 类不受此限。一旦金额或日期文本偏长
   * 就会被静默改写，业主收到的金额与账单不一致，而通知日志只记一句成功。
   */
  it('只截断 thing/phrase 类字段，金额与日期原样发送', async () => {
    process.env.WX_TMPL_BILL_CREATED = 'tmpl-1';
    const getAccessToken = jest.fn().mockResolvedValue('token');
    const fetchMock = jest.fn().mockResolvedValue({ json: async () => ({ errcode: 0 }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new RealWxService({ getAccessToken } as unknown as WxCloudService);

    const longThing = '费'.repeat(30);
    const result = await service.sendSubscribeMessage({
      openid: 'owner-openid',
      templateType: 'BILL_CREATED',
      data: {
        thing12: longThing,
        thing11: longThing,
        // 27 字符，若按 20 截断会变成「￥1234567890123.4」，金额被静默改写
        amount4: '￥1234567890123.45678901',
        time3: '2026年8月26日 23:59 ~ 2026年8月27日 23:59',
        character_string9: 'A'.repeat(32),
      },
    });

    expect(result).toEqual({ ok: true });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.data.thing12.value).toHaveLength(20);
    expect(body.data.thing11.value).toHaveLength(20);
    expect(body.data.amount4.value).toBe('￥1234567890123.45678901');
    expect(body.data.time3.value).toBe('2026年8月26日 23:59 ~ 2026年8月27日 23:59');
    expect(body.data.character_string9.value).toHaveLength(32);
  });
});
