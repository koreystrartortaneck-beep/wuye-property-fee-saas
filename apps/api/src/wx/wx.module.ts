import { Global, Module } from '@nestjs/common';
import { MockWxService } from './wx.mock';
import { RealWxService } from './wx.real';
import { WX_API } from './wx.service';
import { WxCloudService } from './wx-cloud.service';
import { WxProbeService } from './wx-probe.service';

@Global()
@Module({
  providers: [
    RealWxService,
    MockWxService,
    {
      /*
       * WX_MODE 必须显式声明，与 PAYMENT_PROVIDER 的做法一致。
       *
       * 原实现是 `WX_MODE === 'real' ? Real : Mock`——任何非 'real' 的取值都会
       * **静默**退回 Mock：未配置、拼错、大写 'REAL' 都算。而 MockWxService 会
       * 伪造 openid 与手机号，也就是说控制台上一个手误，业主登录就悄悄变成假身份、
       * 订阅消息一条也不会真发，而日志里只会看到 channel=MOCK。
       *
       * 这与对账单渠道被无条件绑到 Mock 是同一类事故：宁可启动失败，
       * 也不要一个看起来在工作、实际是假的微信接入。
       */
      provide: WX_API,
      inject: [RealWxService, MockWxService],
      useFactory: (real: RealWxService, mock: MockWxService) => {
        if (process.env.WX_MODE === 'real') return real;
        if (process.env.WX_MODE === 'mock') {
          if (process.env.ALLOW_MOCK_WX !== 'true') {
            throw new Error('Mock 微信服务必须显式配置 ALLOW_MOCK_WX=true');
          }
          return mock;
        }
        throw new Error('WX_MODE 必须明确配置为 mock 或 real');
      },
    },
    WxCloudService,
    WxProbeService,
  ],
  exports: [WX_API, WxCloudService, WxProbeService],
})
export class WxModule {}
