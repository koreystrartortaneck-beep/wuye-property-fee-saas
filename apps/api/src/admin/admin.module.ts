import { Module } from '@nestjs/common';
import { BindingModule } from '../binding/binding.module';
import { AdminAuthController, AdminAuthService } from './admin-auth.controller';
import { BindingConfigController, BindingConfigService } from './binding-config.controller';
import { HouseContactsController, HouseContactsService } from './house-contacts.controller';
import { HouseGridController, HouseGridService } from './house-grid.controller';
import { BindingsController, BindingsService } from './bindings.controller';
import { CommunitiesController, CommunitiesService } from './communities.controller';
import { HousesController, HousesService } from './houses.controller';
import { StatsController } from './stats.controller';
import { TenantsController, TenantsService } from './tenants.controller';
import { CloudFilesController } from './cloud-files.controller';
import { HouseProfileController, HouseProfileService } from './house-profile.controller';
import { TodayController, TodayService } from './today.controller';
import { MaintenanceController, MaintenanceService } from './maintenance.controller';
import { StaffController, StaffService } from './staff.controller';

@Module({
  imports: [BindingModule],
  controllers: [
    MaintenanceController,
    StaffController,
    TodayController,
    HouseProfileController,
    AdminAuthController,
    TenantsController,
    CommunitiesController,
    HousesController,
    HouseContactsController,
    HouseGridController,
    BindingConfigController,
    BindingsController,
    StatsController,
    CloudFilesController,
  ],
  providers: [
    MaintenanceService,
    StaffService,
    TodayService,
    HouseProfileService,
    AdminAuthService,
    TenantsService,
    CommunitiesService,
    HousesService,
    HouseContactsService,
    HouseGridService,
    BindingConfigService,
    BindingsService,
  ],
})
export class AdminModule {}
