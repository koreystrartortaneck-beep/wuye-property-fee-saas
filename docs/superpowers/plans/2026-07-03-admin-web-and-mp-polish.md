# Web 管理后台 + 小程序优化 实施计划（子项目 3 + 小程序打磨）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 物业 Web 管理后台全量可用（Vue3 + Element Plus），小程序补齐账单详情/申请进度/逾期标识/下拉刷新，后端补统计与绑定查询端点。

**Architecture:** apps/admin 为 Vite + Vue3 单页应用，fetch 封装直连 `/api/v1`（dev 走 Vite proxy）；无状态库（轻量 reactive store + localStorage）；Element Plus 全量引入。

**Tech Stack:** Vue 3.5, vue-router 4, Element Plus 2.x, Vite 6。

## Global Constraints

- 统一响应 `{code,message,data}`；code!==0 时 ElMessage.error 并抛错；40100 跳登录页
- 超管访问租户数据必须带 `X-Tenant-Id`（登录后若 SUPER_ADMIN，顶栏提供租户切换器）
- 金额展示两位小数；日期 `YYYY-MM-DD`
- 小程序视觉风格不动，新增页面沿用现有类名体系

---

### Task A1: 后端补强（统计 + 业主绑定查询）
- `GET /api/v1/admin/stats/summary?communityId&period` → `{billAmount, billCount, paidAmount, paidCount, rate}`（排除 CANCELED）
- `GET /api/v1/admin/stats/by-community?period` → 按小区行 `{communityId, name, billAmount, paidAmount, rate}`
- `GET /api/v1/owner/my/bindings` → 本人全部绑定（含 PENDING/REJECTED + rejectReason + 房屋/小区名）
- e2e：stats 数字与已缴/未缴一致；bindings 返回 PENDING
- Commit

### Task A2: admin 脚手架 + 登录 + 布局
- vite + vue3 + element-plus；`src/api.ts`（fetch 封装/401 跳转/X-Tenant-Id 注入）；`src/store.ts`（token/profile/tenantId persist）
- Login.vue；Layout.vue（侧边菜单/顶栏含超管租户切换 + 退出）；router 守卫
- 验证：`pnpm build` 通过；dev 起服务登录成功跳转
- Commit

### Task A3: 组织管理页
- Tenants.vue（超管：列表/新建含初始管理员/停启用）
- Communities.vue（列表/新建/编辑）
- Houses.vue（筛选列表/单条新增编辑（走 import 单行）/CSV 批量导入对话框：前端解析 CSV → rows → 结果汇报 created/updated/failed 行）
- Bindings.vue（PENDING 列表/通过/驳回带原因；全部状态查询）
- Commit

### Task A4: 计费配置页
- FeeRules.vue（列表；创建/编辑对话框按 ruleType 动态渲染 params 表单：AREA_PRICE unitPrice / FIXED amount / METER unitPrice+meterType / SHARE shareBy / FORMULA expr+vars 键值对；enabled 开关）
- MeterReadings.vue（选小区+period+表类型 → 已录列表 + 未录房屋行内录入）
- SharePools.vue（选 SHARE 规则 → 历史总额 + 本期 upsert）
- Commit

### Task A5: 出账与账单页 + 看板 + 通知
- Bills.vue：上半 BillRun 列表（状态/生成/跳过/skippedDetail 展开/重跑按钮）+ 手动出账表单（选规则+period）；下半账单查询表（筛选/作废）
- Dashboard.vue：期间选择 → summary 卡片 + by-community 表
- NotifyLogs.vue：筛选列表
- `pnpm build` 全绿；curl 冒烟 dev 页面可达
- Commit

### Task A6: 小程序打磨
- 新增 `pages/bill-detail/bill-detail`（金额、状态、计算依据 snapshot 按规则类型渲染、缴费时间/订单号）；账单列表右侧「详情 ›」catchtap 进入，已缴项整卡点击进入
- mine 页：`GET /owner/my/bindings` 渲染「审核中/已驳回(原因)」标签
- 账单列表逾期红标（dueDate < now 且未缴）
- index/bill/payments 启用下拉刷新；index 首屏 loading 文案
- 修复：index goPay 拉取 pageSize=50
- Commit

### Task A7: 回归 + 文档 + 合并
- 后端全测；admin build；README 更新（admin 启动方式、账号）；merge main
