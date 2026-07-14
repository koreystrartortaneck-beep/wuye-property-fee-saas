import { Global, Module } from '@nestjs/common';
import { MockWxService } from './wx.mock';
import { RealWxService } from './wx.real';
import { WX_API } from './wx.service';
import { WxCloudService } from './wx-cloud.service';

@Global()
@Module({
  providers: [
    {
      provide: WX_API,
      useClass: process.env.WX_MODE === 'real' ? RealWxService : MockWxService,
    },
    WxCloudService,
  ],
  exports: [WX_API, WxCloudService],
})
export class WxModule {}
