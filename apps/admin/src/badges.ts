import { reactive } from 'vue';
import { api } from './api';
import type { BadgeKey } from './nav';

/**
 * 待办角标：把"记得去查"变成"系统提醒我"。
 * 只统计「别人在等我处理」的事项，用 pageSize=1 取 total，代价极小。
 * 任何一项失败都静默降级为 0，绝不阻塞导航渲染。
 */
export const badges = reactive<Record<BadgeKey, number>>({
  bindings: 0,
  tickets: 0,
  invoices: 0,
});

interface Total {
  total?: number;
}

async function count(path: string): Promise<number> {
  try {
    const res = await api<Total>(path, { silent: true });
    return typeof res?.total === 'number' ? res.total : 0;
  } catch {
    return 0;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export async function refreshBadges(): Promise<void> {
  const [bindings, tickets, invoices] = await Promise.all([
    count('/admin/bindings?status=PENDING&page=1&pageSize=1'),
    count('/admin/tickets?status=PENDING&page=1&pageSize=1'),
    count('/admin/invoices?status=SUBMITTED&page=1&pageSize=1'),
  ]);
  badges.bindings = bindings;
  badges.tickets = tickets;
  badges.invoices = invoices;
}

/** 登录后启动轮询；退出时停止。60s 一次，够及时且不扰后端。 */
export function startBadgePolling(): void {
  void refreshBadges();
  if (timer) return;
  timer = setInterval(() => void refreshBadges(), 60_000);
}

export function stopBadgePolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  badges.bindings = 0;
  badges.tickets = 0;
  badges.invoices = 0;
}
