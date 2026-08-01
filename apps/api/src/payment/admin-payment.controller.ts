import { Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ErrorCode, PAYMENT_CHANNELS, PAYMENT_STATUSES, PaymentChannel, PaymentStatus } from '@pf/shared';
import { BizException } from '../common/biz.exception';
import { AdminGuard } from '../auth/admin.guard';
import { Current, CurrentAdmin } from '../auth/current.decorator';
import { Roles, RolesGuard } from '../auth/roles.decorator';
import { PageQuery, pageArgs, pageResult } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { OfflinePaymentService } from './offline-payment.service';
import { PaymentService } from './payment.service';

class SettleOfflineDto {
  @IsString()
  @IsNotEmpty()
  billId!: string;

  @IsString()
  @MaxLength(64)
  @IsNotEmpty()
  voucherNo!: string;

  @Type(() => Date)
  @IsDate()
  paidAt!: Date;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  payerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  remark?: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

class ReverseOfflineDto {
  @IsString()
  @MaxLength(191)
  @IsNotEmpty()
  reason!: string;

  @IsString()
  @IsNotEmpty()
  requestId!: string;
}

class ListPaymentsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  communityId?: string;

  @IsOptional()
  @IsIn(PAYMENT_CHANNELS as unknown as string[])
  channel?: PaymentChannel;

  @IsOptional()
  @IsIn(PAYMENT_STATUSES as unknown as string[])
  status?: PaymentStatus;
}

@Injectable()
export class AdminPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListPaymentsQuery) {
    const where = {
      ...(q.communityId ? { communityId: q.communityId } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.t.payment.findMany({
        where,
        ...pageArgs(q),
        orderBy: { createdAt: 'desc' },
        select: {
          orderNo: true, totalAmount: true, discountAmount: true, channel: true, status: true, paidAt: true,
          offlineVoucherNo: true, receiptNo: true, createdAt: true, billId: true,
          /*
           * 带出房屋与费用名称。原先这个列表只有「账单 ID」（一串 cuid）——
           * 收费员核一笔款要拿这个 ID 去别处反查是哪户的哪笔费用，而后台界面上
           * 根本不显示账单 ID。房号才是他们唯一认得的标识。
           */
          bill: {
            select: {
              title: true,
              period: true,
              house: { select: { id: true, code: true, displayName: true } },
            },
          },
        },
      }),
      this.prisma.t.payment.count({ where }),
    ]);
    return pageResult(list, total, q);
  }
  /**
   * 单笔支付的入账溯源。
   *
   * 2026-08-01 事故里最费时间的一环：业主说钱扣了，而后台**没有任何地方**
   * 能看出这笔钱到账了没有、是怎么到账的。
   *   · wxpayNotifiedAt / confirmedBy / transactionId / lastSyncedAt 四个字段都在库里，
   *     但零个端点暴露；列表接口也不返回。
   *   · PaymentEvent 是完整的入账审计链（回调到达、查单裁决），同样零个端点暴露。
   * 结果是排查只能靠猜，而「回调有没有来过」这个决定性问题一直悬着。
   *
   * 这个端点专门回答三个问题：
   *   ① 这笔钱到账了吗（status / paidAt / receiptNo）
   *   ② 怎么到账的（confirmedBy：微信回调 / 主动查单 / 线下登记）
   *   ③ 微信回调到过吗（wxpayNotifiedAt + NOTIFIED 事件）—— 回调链路是否健康看这一项
   */
  async trace(orderNo: string) {
    const payment = await this.prisma.t.payment.findFirst({
      where: { orderNo },
      select: {
        id: true, orderNo: true, channel: true, status: true,
        totalAmount: true, discountAmount: true,
        createdAt: true, paidAt: true, receiptNo: true,
        // 入账路径三件套
        confirmedBy: true, wxpayNotifiedAt: true, lastSyncedAt: true,
        transactionId: true,
        offlineVoucherNo: true,
        bill: {
          select: {
            title: true, period: true, status: true,
            house: { select: { code: true, displayName: true } },
          },
        },
      },
    });
    if (!payment) throw new BizException(ErrorCode.NOT_FOUND);

    const events = await this.prisma.t.paymentEvent.findMany({
      where: { paymentId: payment.id },
      orderBy: { occurredAt: 'asc' },
      select: {
        type: true, status: true, source: true, occurredAt: true,
        processedAt: true, attempts: true, lastError: true, summary: true,
      },
      take: 50,
    });

    return {
      ...payment,
      /*
       * 明确给出结论，而不是让人对着四个字段自己推。
       * 「回调从未到达」是一个需要立刻处理的运维事实（说明微信后台的回调地址、
       * 或出口网络有问题），不该被埋在一个 null 里。
       */
      settlement: {
        paid: payment.status === 'SUCCESS',
        via: payment.confirmedBy,
        wxCallbackArrived: payment.wxpayNotifiedAt !== null,
        queriedAt: payment.lastSyncedAt,
      },
      events,
    };
  }

}

@Controller('admin/payments')
@UseGuards(AdminGuard, RolesGuard)
export class AdminPaymentController {
  constructor(
    private readonly offline: OfflinePaymentService,
    private readonly payments: AdminPaymentsService,
    private readonly paymentService: PaymentService,
  ) {}

  @Get()
  list(@Query() q: ListPaymentsQuery) {
    return this.payments.list(q);
  }

  /*
   * 只读，PLATFORM_READONLY 也该能看 —— 排查支付问题时不该被迫用超管账号。
   * 故意不挂 @Roles：AdminGuard 已保证是管理员，读一笔自己租户的支付溯源没有额外风险。
   */
  @Get('trace/:orderNo')
  trace(@Param('orderNo') orderNo: string) {
    return this.payments.trace(orderNo);
  }

  @Post('offline')
  settleOffline(@Current() cur: CurrentAdmin, @Body() dto: SettleOfflineDto) {
    return this.offline.settleOffline({
      billId: dto.billId,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      voucherNo: dto.voucherNo,
      paidAt: dto.paidAt,
      payerName: dto.payerName,
      remark: dto.remark,
      requestId: dto.requestId,
    });
  }

  /*
   * 冲正把已收的线下款作废（账单回到未缴），等同于资金出账，限定 TENANT_ADMIN。
   * 线下现金核销（上面的 /offline）刻意不限制：那是收费员的日常工作，
   * 且它只会把账单从未缴改成已缴、不会把钱退出去，风险方向相反。
   */
  /**
   * 强制向微信查单并按结果裁决（不等 30 分钟的自动补救窗口）。
   *
   * 为什么需要：业主付了钱、订单卡在 CREATED 时，唯一的自动出路是
   * PaymentRecoveryService 那个 10 分钟一轮、只处理「创建满 30 分钟」的任务。
   * 真实事故里业主就是在这半小时里干等 —— 钱已经扣了，账单还是「待缴」，
   * 界面上什么都不说，而客服除了让他等没有任何手段。
   *
   * 这个接口把「问微信」这件事变成一个可以立刻做的动作：
   * 查到 SUCCESS 就入账（幂等，重复调用无副作用），查到未支付/已关闭就按终态收尾。
   *
   * 限 TENANT_ADMIN：它会改变资金状态。
   */
  @Roles('TENANT_ADMIN')
  @Post(':orderNo/force-sync')
  forceSync(@Param('orderNo') orderNo: string) {
    return this.paymentService.reconcileStaleWxPay(orderNo);
  }

  @Roles('TENANT_ADMIN')
  @Post(':orderNo/reverse-offline')
  reverseOffline(@Current() cur: CurrentAdmin, @Param('orderNo') orderNo: string, @Body() dto: ReverseOfflineDto) {
    return this.offline.reverseOffline({
      orderNo,
      adminId: cur.adminId,
      actingTenantId: cur.tenantId,
      reason: dto.reason,
      requestId: dto.requestId,
    });
  }
}
