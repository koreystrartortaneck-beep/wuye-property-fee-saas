import { Module } from '@nestjs/common';
import { BindingSyncService } from './binding-sync.service';

/*
 * 绑定联动域。只有一个服务:BindingSyncService(见其文件头注释)。
 * Auth(业主授权)、Admin(加号/删号/审批/导入)、Owner(自助申请)三个模块都要用,
 * 显式 import 本模块,不做 @Global —— 依赖看得见,才知道谁在动绑定。
 */
@Module({
  providers: [BindingSyncService],
  exports: [BindingSyncService],
})
export class BindingModule {}
