import { Controller, Get } from '@nestjs/common';

/**
 * 健康检查。除了「活着」还要能回答「这是哪一版」。
 *
 * 为什么加后面这部分：本仓推 GitHub 后由微信云托管自动构建部署，耗时 6~10 分钟且
 * 没有任何回执。此前判断「新版本上没上」只能靠探某个新端点的响应，而这条路会骗人 ——
 * 40400 同时表示「路由不存在」和「记录不存在」，用假 ID 探测分不清「没部署」还是
 * 「路由没注册」，为此白花过十几分钟。更糟的是纯内部改动（比如响应拦截器）根本
 * 没有可观测的外部差异，无从判断。
 *
 * uptimeSec 解决的正是这个：部署会重启进程，uptime 归零。
 * 拿它和「我什么时候推的」一比就知道运行的是不是新版本 —— 不需要构建流水线注入
 * 任何东西，也不依赖被测改动本身可观测。
 *
 * 刻意不返回 commit SHA：那要靠构建期注入环境变量，微信云托管这侧不确定支持，
 * 做成一个「有时是 unknown」的字段不如不做。uptime 已经够用。
 *
 * 这些字段都不敏感（无版本号泄露面之外的内容，且本接口本来就是公开的探活地址）：
 * 进程运行时长与当前时间对攻击者没有价值，而对判断部署状态的价值是决定性的。
 */
@Controller('health')
export class HealthController {
  /** 进程启动时刻。模块加载时取一次，之后不变。 */
  private static readonly startedAt = new Date();

  @Get()
  health() {
    const now = new Date();
    return {
      status: 'up',
      startedAt: HealthController.startedAt.toISOString(),
      uptimeSec: Math.floor((now.getTime() - HealthController.startedAt.getTime()) / 1000),
      serverTime: now.toISOString(),
    };
  }
}
