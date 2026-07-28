import { Global, Module } from '@nestjs/common';
import { MockWxService } from './wx.mock';
import { RealWxService } from './wx.real';
import { WX_API } from './wx.service';
import { WxCloudService } from './wx-cloud.service';
import { WxProbeService } from './wx-probe.service';

@Global()
@Module({
  providers: [
    {
      provide: WX_API,
      useClass: process.env.WX_MODE === 'real' ? RealWxService : MockWxService,
    },
    WxCloudService,
    WxProbeService,
  ],
  exports: [WX_API, WxCloudService, WxProbeService],
})
export class WxModule {}
