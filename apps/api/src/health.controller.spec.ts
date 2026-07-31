import { HealthController } from './health.controller';

/**
 * 这组守卫钉住的是「部署可判断」这件事本身。
 *
 * 起因：本仓推 GitHub 后由微信云托管自动构建，6~10 分钟且没有回执。
 * 此前判断新版本是否上线只能探新端点，而 40400 同时表示「路由不存在」与
 * 「记录不存在」，分不清「没部署」还是「路由没注册」—— 为此白花过十几分钟。
 * 纯内部改动（响应拦截器之类）更是完全没有可观测差异。
 *
 * uptimeSec 是这个问题的答案：部署必然重启进程，uptime 归零。
 * 所以它不是锦上添花的运维字段，删掉就会回到「无法判断部署状态」。
 */
describe('健康检查要能回答「这是哪一版」', () => {
  it('返回 status 之外还要有启动时刻与运行时长', () => {
    const body = new HealthController().health();
    expect(body.status).toBe('up');
    // 三个字段各有用处：uptime 判断是否刚重启，startedAt 与推送时间对齐，
    // serverTime 排除「容器时钟不对」这种会让前两个结论全错的情况
    expect(typeof body.uptimeSec).toBe('number');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(() => new Date(body.startedAt).toISOString()).not.toThrow();
    expect(() => new Date(body.serverTime).toISOString()).not.toThrow();
  });

  it('startedAt 是进程启动时刻而不是每次请求的当前时间', () => {
    /*
     * 若把 startedAt 写成 new Date() 现取，uptime 会恒为 0 —— 看起来「有这个字段」，
     * 但完全失去判断部署的能力。这是最容易写错的一版，必须钉住。
     */
    const a = new HealthController().health();
    const b = new HealthController().health();
    // 不同实例也必须报同一个启动时刻（静态字段，随模块加载一次）
    expect(b.startedAt).toBe(a.startedAt);
  });

  it('uptimeSec 随时间推进而增长', () => {
    const ctrl = new HealthController();
    const first = ctrl.health();
    const later = new Date(Date.now() + 5_000);
    const spy = jest.spyOn(global, 'Date').mockImplementation(() => later as unknown as Date);
    try {
      // Date 被 mock 后 new Date() 返回 later，uptime 应比刚才大 5 秒左右
      const second = ctrl.health();
      expect(second.uptimeSec).toBeGreaterThanOrEqual(first.uptimeSec + 4);
    } finally {
      spy.mockRestore();
    }
  });

  it('不返回敏感信息', () => {
    // 探活地址是公开的：不能顺手把环境变量、路径、密钥名带出去
    const body = new HealthController().health() as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['serverTime', 'startedAt', 'status', 'uptimeSec']);
  });
});
