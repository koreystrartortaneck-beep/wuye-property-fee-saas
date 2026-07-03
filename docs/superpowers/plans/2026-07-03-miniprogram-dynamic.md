# 小程序动态化 实施计划（子项目 4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 静态原型接入真实 API：登录、绑房、多房切换、账单、合并支付（mock）、缴费记录。保留现有视觉风格。

**Architecture:** 原生小程序 + 轻量 `request` 封装（token 注入、401 静默重登、统一错误 toast）。dev 环境用 mock 约定（`mock:` code / `phone:` code / mock-confirm）。

**Tech Stack:** 微信原生小程序（无框架），后端 `/api/v1`。

## Global Constraints

- 依据 spec §9；视觉风格不动（wxss 尽量不改）
- 所有金额展示两位小数；后端 Decimal 序列化可能为 `"262"`，前端格式化
- dev 配置 `apps/miniprogram/config.js`：`baseURL`、`mockAuth: true`
- 手机号授权：mock 模式用输入框收手机号 → `phone:<号码>`；real 模式用 `getphonenumber` 开放能力（留接口）
- 测试方式：微信开发者工具人工验收（无自动化）；每任务提供验收清单

---

### Task M1: request 封装与登录态

**Files:** Create `apps/miniprogram/config.js`, `apps/miniprogram/utils/request.js`, `apps/miniprogram/utils/auth.js`；Modify `app.js`

- `config.js`: `{ baseURL: 'http://127.0.0.1:3000/api/v1', mockAuth: true }`
- `request.js`: `request(path, {method, data})` → Promise；注入 `Authorization: Bearer <token>`（storage `pf_token`）；`code!==0` 时 reject 并 `wx.showToast(message)`；`code===40100` 时清 token → 重新登录一次后重放请求
- `auth.js`: `ensureLogin()`：有 token 直接返回；无则 `wx.login` 取 code（mockAuth 时改为 `mock:` + 持久化随机串）→ `POST /auth/wx-login` → 存 token 与 user；`bindPhone(phone)` → `POST /auth/phone {code: 'phone:'+phone}`
- `app.js`: onLaunch 调 `ensureLogin()`，globalData 存 user/houses/currentHouse
- 验收：开发者工具 Network 可见 wx-login 成功、storage 有 token

### Task M2: 绑房页 + 首页动态化

**Files:** Create `pages/bind-house/*`；Modify `pages/index/*`、`app.json`

- 绑房页：搜索小区（`GET /owner/communities?keyword=`）→ 选房号（`GET /owner/communities/:id/houses`）→ 填姓名/关系提交申请；或输入手机号自动匹配（mock）
- 首页：onShow 拉 `GET /owner/my/houses` + `GET /owner/bills/summary?houseId=`；无房 → 引导进绑房页；房屋切换器（多房）；账单卡片列表来自 `GET /owner/bills?houseId&status=UNPAID`（前 3 条）
- 验收：seed 的 `phone:13800138000` 绑定 3 房，首页显示真实待缴金额

### Task M3: 账单页动态化（tab 真过滤）

**Files:** Modify `pages/bill/*`

- tabs 全部/待缴/已缴 → status 参数重查；下拉分页；金额小计
- 选择账单（复选）→ 底部合计 → 去支付按钮带所选 billIds
- 验收：切 tab 数据变化正确；已缴显示 paidAt

### Task M4: 支付链路（确认页/成功页/缴费记录）

**Files:** Modify `pages/pay-confirm/*`、`pages/pay-success/*`；Create `pages/payments/*`

- 确认页：接收 billIds → 展示明细与合计 → `POST /owner/payments` → mock 模式直接调 `mock-confirm` → 跳成功页（带 orderNo）
- 成功页：`GET /owner/payments/:orderNo` 展示真实订单号/金额/时间
- 缴费记录页：`GET /owner/payments` 分页列表；mine 页菜单接入口
- 验收：支付后首页汇总减少、账单页状态变已缴、记录页有订单

### Task M5: mine 页动态化 + 收尾

**Files:** Modify `pages/mine/*`、`app.json`
- 用户手机号、房屋列表（真数据）、菜单跳转（缴费记录/我的房屋→绑房页）
- 全流程回归验收清单跑一遍；commit
