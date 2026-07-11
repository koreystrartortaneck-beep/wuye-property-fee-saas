import { Body, Controller, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { SERVICE_ORDER_STATUSES, ServiceOrderStatus } from '@pf/shared';
import { AdminGuard } from '../auth/admin.guard';
import { RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { ServicesService } from './services.service';

class CreateItemDto {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  coverImage?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

class UpdateItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  coverImage?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

class ListOrdersQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(SERVICE_ORDER_STATUSES as unknown as string[])
  status?: ServiceOrderStatus;
}

@Injectable()
class ServiceItemsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateItemDto) {
    return this.prisma.t.serviceItem.create({ data: { ...dto, communityId: dto.communityId || null } as never });
  }

  async list(q: PageQuery & { communityId?: string }) {
    const where = q.communityId ? { OR: [{ communityId: q.communityId }, { communityId: null }] } : {};
    const [list, total] = await Promise.all([
      this.prisma.t.serviceItem.findMany({ where, ...pageArgs(q), orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.t.serviceItem.count({ where }),
    ]);
    return pageResult(list, total, q);
  }

  update(id: string, dto: UpdateItemDto) {
    return this.prisma.t.serviceItem.update({ where: { id }, data: dto });
  }
}

@Controller('admin')
@UseGuards(AdminGuard, RolesGuard)
export class AdminServicesController {
  private readonly items: ServiceItemsService;
  constructor(
    private readonly orders: ServicesService,
    prisma: PrismaService,
  ) {
    this.items = new ServiceItemsService(prisma);
  }

  // ----- 服务菜单 -----
  @Post('service-items')
  createItem(@Body() dto: CreateItemDto) {
    return this.items.create(dto);
  }

  @Get('service-items')
  listItems(@Query() q: ListOrdersQuery) {
    return this.items.list(q);
  }

  @Patch('service-items/:id')
  updateItem(@Param('id') id: string, @Body() dto: UpdateItemDto) {
    return this.items.update(id, dto);
  }

  // ----- 预约单 -----
  @Get('service-orders')
  listOrders(@Query() q: ListOrdersQuery) {
    return this.orders.adminOrders(q);
  }

  @Post('service-orders/:id/accept')
  accept(@Param('id') id: string) {
    return this.orders.accept(id);
  }

  @Post('service-orders/:id/done')
  done(@Param('id') id: string) {
    return this.orders.done(id);
  }

  @Post('service-orders/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.orders.adminCancel(id);
  }
}
