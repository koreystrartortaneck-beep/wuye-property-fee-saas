/*
 * 短轮询 —— 只在「有东西正在变」的时候转,变完就停。
 *
 * 为什么需要它:退款和支付的最终状态不由本地决定 —— 微信回调什么时候到、
 * 查单什么时候裁决,都是几秒到两分钟的事。页面不刷新,人看到的就是「退款中」,
 * 而库里早就 REFUNDED 了(2026-08-04 实测:¥17 那笔退款已完成,界面还写着退款中)。
 * onShow 刷新救不了这种情况:人根本没离开页面。
 *
 * 为什么不干脆开个常驻定时器:管理端十几个页面都这么干,就是白烧电和流量,
 * 而绝大多数时候没有任何东西在变。所以:
 *   · 有 pending 才起(由调用方判断什么算 pending)
 *   · 没有了立刻停
 *   · 间隔递增(3s → 30s):刚操作完那几秒最需要快,越久越不必频繁
 *   · 总时长封顶(默认 3 分钟)—— 再没结果就是真出问题了,该看溯源而不是干等
 *   · 页面隐藏/卸载必须调 stop():小程序不会替你清定时器
 */

const DEFAULT_STEPS = [3000, 5000, 8000, 12000, 20000, 30000];

/**
 * @param {object} o
 * @param {() => Promise<void>} o.load        重新拉数据(通常就是页面的 load)
 * @param {() => boolean} o.isPending         还有东西在变吗(读最新的 this.data)
 * @param {number[]} [o.steps]                递增间隔
 * @param {number} [o.maxMs]                  总时长上限
 * @param {() => void} [o.onGiveUp]           超时放弃时的回调(可用来提示「请稍后查看溯源」)
 */
function createPoller({ load, isPending, steps = DEFAULT_STEPS, maxMs = 180000, onGiveUp }) {
  let timer = null;
  let i = 0;
  let startedAt = 0;
  let stopped = false;

  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    i = 0;
    startedAt = 0;
  }

  /** 每次 load 完成后调一次:该转就转,不该转就停 */
  function kick() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!isPending()) {
      // 变完了 —— 归零,下次再出现 pending 时重新从最短间隔开始
      i = 0;
      startedAt = 0;
      return;
    }
    stopped = false;
    if (!startedAt) startedAt = Date.now();
    if (Date.now() - startedAt > maxMs) {
      i = 0;
      startedAt = 0;
      if (onGiveUp) onGiveUp();
      return;
    }
    const wait = steps[Math.min(i, steps.length - 1)];
    i += 1;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      try {
        await load();
      } catch (e) {
        // 一次拉取失败不该终止轮询:下一轮照常(间隔已经在递增)
      }
      if (!stopped) kick();
    }, wait);
  }

  return { kick, stop };
}

module.exports = { createPoller };
