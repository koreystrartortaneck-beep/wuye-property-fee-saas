import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { WxApi } from '../wx/wx.service';

describe('AuthService 云托管身份', () => {
  it('提供可信 openid 时不调用 jscode2session', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 'user-id', phone: null });
    const prisma = { raw: { wxUser: { upsert } } } as unknown as PrismaService;
    const jwt = { signAsync: jest.fn().mockResolvedValue('owner-token') };
    const wx = { code2session: jest.fn() } as unknown as WxApi;
    const service = new AuthService(prisma, jwt as never, wx);

    await expect(
      (service.wxLogin as unknown as (code: string, openid?: string) => Promise<unknown>)('unused-code', 'cloud-openid'),
    ).resolves.toEqual({ token: 'owner-token', user: { id: 'user-id', hasPhone: false } });

    expect(wx.code2session).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({
      where: { openid: 'cloud-openid' },
      create: { openid: 'cloud-openid' },
      update: {},
    });
  });
});
