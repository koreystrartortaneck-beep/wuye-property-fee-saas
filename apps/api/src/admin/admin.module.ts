import { Module } from '@nestjs/common';
import { AdminAuthController, AdminAuthService } from './admin-auth.controller';
import { BindingsController, BindingsService } from './bindings.controller';
import { CommunitiesController, CommunitiesService } from './communities.controller';
import { HousesController, HousesService } from './houses.controller';
import { StatsController } from './stats.controller';
import { TenantsController, TenantsService } from './tenants.controller';
import { CloudFilesController } from './cloud-files.controller';
import { HouseProfileController, HouseProfileService } from './house-profile.controller';
import { TodayController, TodayService } from './today.controller';

@Module({
  controllers: [
    TodayController,
    HouseProfileController,
    AdminAuthController,
    TenantsController,
    CommunitiesController,
    HousesController,
    BindingsController,
    StatsController,
    CloudFilesController,
  ],
  providers: [TodayService, HouseProfileService, AdminAuthService, TenantsService, CommunitiesService, HousesService, BindingsService],
})
export class AdminModule {}
