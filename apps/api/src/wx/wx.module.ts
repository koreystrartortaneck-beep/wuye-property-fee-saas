import { Global, Module } from '@nestjs/common';
import { MockWxService } from './wx.mock';
import { RealWxService } from './wx.real';
import { WX_API } from './wx.service';

@Global()
@Module({
  providers: [
    {
      provide: WX_API,
      useClass: process.env.WX_MODE === 'real' ? RealWxService : MockWxService,
    },
  ],
  exports: [WX_API],
})
export class WxModule {}
