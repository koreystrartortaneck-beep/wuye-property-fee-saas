/**
 * 信息架构单一真源：21 个页面折叠为 6 个「去处」。
 *
 * 设计原则：
 * - 侧栏只放"去处"（最多 6 个），子页面用内容区顶部的分段控件切换，不再平铺进侧栏。
 * - 排序按用户任务节奏：每天看的在最上，一次性配置的收在设置。
 * - badge 指向"别人在等我处理"的事项，把"记得去查"变成"系统提醒我"。
 * - 命名说人话：避免"绑定/公摊/策略/审计"这类内部术语。
 */

export interface NavPage {
  path: string;
  /** 分段控件上的短标签 */
  label: string;
  /** 内容区大标题（缺省用 label） */
  title?: string;
  /** 一句话说明这个页面能干什么，降低陌生感 */
  hint?: string;
  /** 对应 badge 计数键 */
  badge?: BadgeKey;
  superOnly?: boolean;
}

export interface NavGroup {
  key: string;
  label: string;
  icon: string;
  pages: NavPage[];
}

export type BadgeKey = 'bindings' | 'tickets' | 'invoices';

export const NAV: NavGroup[] = [
  {
    key: 'today',
    label: '今天',
    icon: 'Odometer',
    pages: [
      {
        path: '/dashboard',
        label: '概览',
        title: '今天',
        hint: '本月收缴进度与待办事项',
      },
    ],
  },
  {
    key: 'residents',
    label: '住户',
    icon: 'HomeFilled',
    pages: [
      { path: '/houses', label: '房屋与业主', hint: '房号、面积、业主联系方式；支持批量导入' },
      {
        path: '/bindings',
        label: '实名审核',
        title: '业主实名审核',
        hint: '核对申请人与登记业主是否一致后再通过，避免他人查看费用',
        badge: 'bindings',
      },
    ],
  },
  {
    key: 'billing',
    label: '收费',
    icon: 'Tickets',
    pages: [
      {
        path: '/bill-run',
        label: '出账',
        title: '出账（每月一次）',
        hint: '按 4 步完成：设收费标准 → 选账期 → 生成账单 → 核对后发布给业主',
      },
      { path: '/bills', label: '账单查询', hint: '查看每户的账单、缴费与逾期情况' },
      { path: '/bill-import', label: '导入账单', hint: '每户金额不同时，用表格批量导入' },
      { path: '/meters', label: '抄表', title: '水电气抄表', hint: '录入本期读数，用于按量计费' },
      { path: '/share-pools', label: '公共分摊', title: '公共水电分摊', hint: '录入本期公共能耗总额并分摊到各户' },
      { path: '/fee-rules', label: '收费标准', hint: '设置每平米单价、固定费用等计费方式（高级设置）' },
    ],
  },
  {
    key: 'finance',
    label: '财务',
    icon: 'Wallet',
    pages: [
      { path: '/payments', label: '收款与退款', hint: '微信收款流水、登记线下现金、办理退款' },
      { path: '/reconciliations', label: '对账', title: '微信对账', hint: '与微信支付逐日核对，处理差异' },
      { path: '/invoices', label: '开票', title: '开票申请', hint: '处理业主的发票申请', badge: 'invoices' },
    ],
  },
  {
    key: 'community',
    label: '社区',
    icon: 'ChatDotSquare',
    pages: [
      { path: '/tickets', label: '报事报修', hint: '受理、派单、办结业主的报修与投诉', badge: 'tickets' },
      { path: '/announcements', label: '公告', title: '社区公告', hint: '发布通知，业主端可见' },
      { path: '/visitor-passes', label: '访客', title: '访客通行', hint: '查询与核销业主生成的通行码' },
      { path: '/work-logs', label: '巡检留痕', hint: '上传巡检、保洁等工作照片' },
    ],
  },
  {
    key: 'settings',
    label: '设置',
    icon: 'Setting',
    pages: [
      { path: '/communities', label: '小区信息', hint: '小区名称、地址、管家电话' },
      { path: '/billing-settings', label: '暂停收款', title: '暂停收款开关', hint: '紧急情况下暂停业主在线缴费' },
      { path: '/services', label: '生活服务', hint: '可选的增值服务项目' },
      { path: '/coupons', label: '优惠券', hint: '可选的营销活动' },
      { path: '/notify-logs', label: '通知记录', hint: '发给业主的提醒记录' },
      { path: '/audit-logs', label: '操作留痕', hint: '谁在什么时候改了什么' },
      { path: '/tenants', label: '物业公司', hint: '平台级：管理各物业公司', superOnly: true },
    ],
  },
];

/** 路径 → 所属分组 / 页面配置（供布局与面包屑使用） */
export function locate(path: string): { group: NavGroup; page: NavPage } | null {
  for (const group of NAV) {
    const page = group.pages.find((p) => p.path === path);
    if (page) return { group, page };
  }
  return null;
}
