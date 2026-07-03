import { Module } from '@nestjs/common';
import { AdminAuthController, AdminAuthService } from './admin-auth.controller';
import { BindingsController, BindingsService } from './bindings.controller';
import { CommunitiesController, CommunitiesService } from './communities.controller';
import { HousesController, HousesService } from './houses.controller';
import { StatsController } from './stats.controller';
import { TenantsController, TenantsService } from './tenants.controller';

@Module({
  controllers: [
    AdminAuthController,
    TenantsController,
    CommunitiesController,
    HousesController,
    BindingsController,
    StatsController,
  ],
  providers: [AdminAuthService, TenantsService, CommunitiesService, HousesService, BindingsService],
})
export class AdminModule {}
