import { ErrorCode } from '@pf/shared';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthController 云托管身份', () => {
  const originalEnv = { ...process.env };
  let auth: { wxLogin: jest.Mock };
  let controller: AuthController;

  beforeEach(() => {
    process.env = { ...originalEnv, WX_APPID: 'expected-appid' };
    delete process.env.WX_CLOUD_ENV;
    auth = { wxLogin: jest.fn().mockResolvedValue({ token: 'token' }) };
    controller = new AuthController(auth as unknown as AuthService, {} as PrismaService);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('可信 callContainer 请求使用平台注入的 openid', async () => {
    process.env.WX_CLOUD_ENV = 'cloud-env';
    await (controller.wxLogin as unknown as (...args: unknown[]) => Promise<unknown>)(
      { code: 'unused-code' },
      'cloud-openid',
      'wx_client',
      'expected-appid',
      undefined,
    );

    expect(auth.wxLogin).toHaveBeenCalledWith('unused-code', 'cloud-openid');
  });

  it('非云环境不能通过伪造完整微信 header 获取身份', async () => {
    await (controller.wxLogin as unknown as (...args: unknown[]) => Promise<unknown>)(
      { code: 'real-code' },
      'forged-openid',
      'wx_client',
      'expected-appid',
      'WX_SERVER_AUTH',
    );

    expect(auth.wxLogin).toHaveBeenCalledWith('real-code', undefined);
  });

  it('可信来源的 AppID 不匹配时拒绝登录', () => {
    process.env.WX_CLOUD_ENV = 'cloud-env';
    try {
      (controller.wxLogin as unknown as (...args: unknown[]) => unknown)(
        { code: 'unused-code' },
        'cloud-openid',
        'wx_client',
        'other-appid',
        undefined,
      );
      throw new Error('expected wxLogin to reject mismatched appid');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
    }
    expect(auth.wxLogin).not.toHaveBeenCalled();
  });

  it('云请求缺少平台注入的 AppID 时拒绝登录', () => {
    process.env.WX_CLOUD_ENV = 'cloud-env';
    try {
      (controller.wxLogin as unknown as (...args: unknown[]) => unknown)(
        { code: 'unused-code' },
        'cloud-openid',
        'wx_client',
        undefined,
        undefined,
      );
      throw new Error('expected wxLogin to require cloud appid');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
    }
    expect(auth.wxLogin).not.toHaveBeenCalled();
  });

  it('云环境缺少 WX_APPID 配置时拒绝登录', () => {
    process.env.WX_CLOUD_ENV = 'cloud-env';
    delete process.env.WX_APPID;
    try {
      (controller.wxLogin as unknown as (...args: unknown[]) => unknown)(
        { code: 'unused-code' },
        'cloud-openid',
        'wx_client',
        'expected-appid',
        undefined,
      );
      throw new Error('expected wxLogin to require configured appid');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.UNAUTHORIZED.code });
    }
    expect(auth.wxLogin).not.toHaveBeenCalled();
  });
});
