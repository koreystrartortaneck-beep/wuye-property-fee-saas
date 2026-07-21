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
});
