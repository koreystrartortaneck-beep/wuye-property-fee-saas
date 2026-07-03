# 物业费缴纳 SaaS 系统 · 总体设计

日期：2026-07-03
状态：已批准（产品负责人授权全权推进，方案 A 已确认）

## 1. 目标与范围

面向**多家物业公司**的多租户 SaaS 物业费系统，三端：

1. **业主端微信小程序**（已有静态原型，风格保留）：登录、绑定房屋、查账单、缴费、缴费记录
2. **物业 Web 管理后台**：配置收费规则、管理房产/业主、抄表与公摊录入、账单与收缴管理、绑定审核
3. **后端服务**：多租户数据模型、计费规则引擎、定时自动出账、消息推送、支付

**非目标（本期不做）**：报事报修、社区公告、门禁、发票开具、多语言、App。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 服务范围 | 多物业公司 SaaS（租户 → 小区 → 房屋） |
| 管理侧 | 独立 Web 后台（Vue3 + Element Plus） |
| 资金流 | 支付层可插拔：先 Mock 支付跑通全流程，后接微信支付**服务商模式**（每家物业为特约商户，避免二清） |
| 计费规则 | 单价×面积、固定金额、抄表计量、公摊分摊 + 自定义公式 |
| 催缴 | 出账推送 + 到期前提醒 + 逾期提醒（不计违约金） |
| 房屋绑定 | 手机号自动匹配为主，自助申请 + 物业审核兜底 |
| 技术栈 | Node.js + TypeScript（NestJS 11 + Prisma + MySQL 8 + Redis），pnpm monorepo |
| 架构 | 模块化单体；多租户 = 单库共享表 + tenant_id 行级隔离 |
| 部署 | 本地 Docker Compose 先行，验收后迁云服务器（同一套 compose + 反向代理 TLS） |
| 微信能力 | 全部 mock/real 双模式，由环境变量切换（`WX_MODE=mock|real`） |

## 3. 子项目分解与顺序

| # | 子项目 | 交付物 | 依赖 |
|---|---|---|---|
| 1 | 后端核心 | monorepo 骨架、数据模型、认证、租户隔离、基础 CRUD API | — |
| 2 | 计费引擎与出账 | 规则模型、5 种规则计算、定时出账、抄表/公摊录入 API、Mock 支付 | 1 |
| 3 | Web 管理后台 | 物业操作界面全量 | 1,2 |
| 4 | 小程序动态化 | 静态原型接真实 API | 1,2 |
| 5 | 支付与推送 | 微信服务商支付、订阅消息、对账 | 4 + 商务资料 |

每个子项目独立计划、独立验收；1、2 合并为同一实施阶段的前后半程。

## 4. 仓库结构

```
物业费缴纳小程序/                  # monorepo 根（git 仓库）
├── apps/
│   ├── api/                     # NestJS 后端
│   ├── admin/                   # Vue3 + Element Plus 管理后台
│   └── miniprogram/             # 微信小程序（现有代码迁入）
├── packages/
│   └── shared/                  # 共享 TS 类型、枚举、错误码
├── docs/                        # 设计文档、用户待办清单
├── docker-compose.yml           # mysql + redis + api + admin(nginx)
└── pnpm-workspace.yaml
```

## 5. 数据模型（Prisma / MySQL）

> 金额一律 `DECIMAL(12,2)`；所有租户域表带 `tenantId` 并建索引；软删除仅用于 Tenant/Community/House（`status` 字段），业务单据不删除。

### 5.1 租户与组织

- **Tenant** 物业公司：`id, name, code(unique), contactName, contactPhone, subMchId?(特约商户号,预留), status(ACTIVE|DISABLED)`
- **AdminUser** 后台账号：`id, tenantId?(null=平台超管), username(unique), passwordHash(bcrypt), name, role(SUPER_ADMIN|TENANT_ADMIN|STAFF), status`
- **Community** 小区：`id, tenantId, name, address, status`
- **House** 计费对象：`id, tenantId, communityId, type(RESIDENCE|PARKING|SHOP), building, unit, room, code("8-1-2602"/"B2-118"), displayName, area?(DECIMAL(10,2), 车位可空), ownerName, ownerPhone, status`
  - 唯一约束 `(communityId, code)`
  - 车位、商铺与住宅统一为 House，规则按 `type` 圈定适用范围

### 5.2 业主与绑定

- **WxUser**：`id, openid(unique), unionid?, phone?, nickname?, createdAt`
- **HouseBinding**：`id, wxUserId, houseId, relation(OWNER|FAMILY|TENANT), status(PENDING|ACTIVE|REJECTED), source(PHONE_MATCH|APPLY), reviewedBy?, reviewedAt?, rejectReason?`
  - 唯一约束 `(wxUserId, houseId)`
  - 手机号授权成功 → 自动匹配 `House.ownerPhone` → 直接创建 ACTIVE 绑定
  - 自助申请（选小区/楼栋/房号 + 姓名 + 关系）→ PENDING → 后台审核

### 5.3 计费与账单

- **FeeRule** 收费规则：
  `id, tenantId, communityId, name("物业管理费"), houseType(适用对象类型), ruleType(AREA_PRICE|FIXED|METER|SHARE|FORMULA), params(JSON), period(MONTHLY|QUARTERLY|YEARLY), billDay(1-28, 出账日), dueDays(出账后N天到期), enabled`
  - `params` 各类型结构：
    - AREA_PRICE: `{ "unitPrice": 2.5 }` → 金额 = unitPrice × area
    - FIXED: `{ "amount": 360 }`
    - METER: `{ "unitPrice": 0.6, "meterType": "WATER|ELEC|GAS" }` → 金额 = unitPrice × (本期读数 − 上期读数)
    - SHARE: `{ "shareBy": "AREA|HOUSE" }` → 按面积或按户分摊本期录入的总额
    - FORMULA: `{ "expr": "area * price * 0.9", "vars": { "price": 2.5 } }`
      - 表达式用 `expr-eval` 安全求值，白名单变量仅 `area` 与 `vars.*`（自定义常量）；禁函数调用与赋值；抄表/公摊类需求用对应专用类型，不塞进公式
- **MeterReading** 抄表：`id, tenantId, houseId, meterType, period("2026-07"), value(本期读数), prevValue(快照), createdBy`；唯一 `(houseId, meterType, period)`
- **SharePool** 公摊总额：`id, tenantId, ruleId, period, totalAmount`；唯一 `(ruleId, period)`
- **BillRun** 出账批次：`id, tenantId, ruleId, period, status(RUNNING|DONE|FAILED), total, generated, skipped, skippedDetail(JSON), startedAt, finishedAt`；唯一 `(ruleId, period)` → **幂等锚点**
- **Bill** 账单：`id, tenantId, communityId, houseId, ruleId, billRunId, period, title, snapshot(JSON: 计算依据快照), amount, status(UNPAID|PAID|CANCELED), dueDate, paidAt?, paymentId?`
  - 唯一 `(ruleId, houseId, period)` → 重跑批次不产生重复账单

### 5.4 支付与通知

- **Payment**：`id, tenantId, wxUserId, orderNo(unique, "WY"+日期+序列), totalAmount, channel(MOCK|WXPAY), status(CREATED|SUCCESS|FAILED|CLOSED|REFUNDED), transactionId?, paidAt?`
- **PaymentBill**：`paymentId, billId`（一次支付合并多张账单）
- **NotifyLog**：`id, tenantId, wxUserId, billId?, type(BILL_CREATED|DUE_SOON|OVERDUE), channel(WX_SUBSCRIBE|MOCK), status(SENT|FAILED|SKIPPED_NO_QUOTA), error?, sentAt`

## 6. 关键流程

### 6.1 认证

- **业主端**：`POST /api/v1/auth/wx-login {code}` → code2session 得 openid（mock 模式下 `code="mock:任意串"` 直接当 openid）→ 建/查 WxUser → 签发 owner JWT（7 天）
- **手机号**：`POST /api/v1/auth/phone {code}` → 微信取号接口（mock 模式直接收明文手机号）→ 存 phone → 触发自动匹配绑定
- **后台**：`POST /api/v1/admin/auth/login {username,password}` → admin JWT（12 小时，payload 含 tenantId + role）
- 两类 JWT secret 相同、`typ` 字段区分，Guard 按端拦截

### 6.2 租户隔离（安全核心）

- admin JWT 携带 `tenantId`；全局 `TenantGuard` 将其注入请求上下文（CLS）
- Prisma Client Extension 对所有带 `tenantId` 的模型**自动追加 where 条件与写入值**，业务代码无法遗漏
- SUPER_ADMIN 通过显式 `X-Tenant-Id` 头切换租户视角；业主端接口一律经 `HouseBinding(ACTIVE)` 间接授权，不信任客户端传入的 houseId

### 6.3 自动出账

每日 02:00 定时任务（`@nestjs/schedule`）：

1. 找出 `enabled` 且 `billDay == 今天的日` 且当月命中周期锚点的规则（MONTHLY 每月；QUARTERLY 仅 1/4/7/10 月；YEARLY 仅 1 月）；`period` 标签相应为 `2026-07` / `2026-Q3` / `2026`
2. 对每条规则：`BillRun` upsert（唯一键挡重复）→ 圈定小区内适用 House → 逐户计算
3. METER 缺读数、SHARE 缺总额 → 该户/该批次跳过并记入 `skippedDetail`，后台可见、补录后可手动重跑批次（幂等，只补生成缺的）
4. 出账成功 → 逐户写 NotifyLog 并推送「出账通知」
5. 每日同任务扫描：`dueDate - 3天` 发到期提醒；`dueDate` 已过且 UNPAID 发逾期提醒（每张账单每类提醒最多一次）

### 6.4 支付

`PaymentProvider` 接口：`createOrder(payment) → 前端支付参数`、`handleNotify(raw) → 支付结果`、`query(orderNo)`、`close(orderNo)`

- **MockProvider**（本期）：createOrder 返回 mock 参数，小程序端直接调 `POST /payments/:orderNo/mock-confirm` 模拟成功
- **WxPayPartnerProvider**（子项目 5）：服务商模式 JSAPI，`sub_mchid = tenant.subMchId`，回调验签 + 幂等更新
- 支付成功（事务内）：Payment → SUCCESS，关联 Bill → PAID + paidAt；不允许部分成功

### 6.5 微信能力双模式

`WxService` 接口 + `MockWxService` / `RealWxService` 两实现，`WX_MODE` 环境变量切换。覆盖：code2session、取手机号、订阅消息发送。mock 实现落库/打日志，保证本地全流程可测。

## 7. API 约定

- REST，前缀 `/api/v1`；业主端 `/api/v1/owner/**`，后台 `/api/v1/admin/**`，认证 `/api/v1/auth/**`
- 统一响应 `{ code: 0, message: "ok", data }`；业务错误码定义在 `packages/shared`（如 `41001 未绑定房屋`）
- 分页统一 `{ page, pageSize } → { list, total, page, pageSize }`
- 全局 ValidationPipe（class-validator DTO）+ 全局异常过滤器；未知异常返回 `code:50000` 不泄漏堆栈

## 8. 管理后台页面清单（子项目 3）

登录 / 租户管理（仅超管）/ 小区管理 / 房产管理（含 CSV 批量导入）/ 绑定审核 / 收费规则配置 / 抄表录入 / 公摊录入 / 账单批次与账单管理（查询、作废、手动重跑）/ 收缴看板（本期应收、实收、收缴率）/ 通知记录

## 9. 小程序改造清单（子项目 4）

- 新增：登录页（微信授权 + 手机号）、绑定房屋页（选小区/楼栋/房号申请）、缴费记录页、电子收据（先做缴费详情页）
- 改造：首页/账单页接 API 并按房屋切换、账单 tab 真实过滤、确认支付页走 Payment 流程（mock 确认）、支付成功页显示真实订单
- `request` 封装：baseURL 环境切换、JWT 注入、401 静默重登
- 保留现有视觉风格

## 10. 错误处理与边界

- 出账幂等：BillRun + Bill 双唯一键，任何重跑不产生重复账单
- 支付并发：订单创建时校验账单 UNPAID 且未被其他进行中订单占用；回调幂等（orderNo + 状态机）
- 抄表回退：读数小于上期 → 拒绝录入并提示
- 规则修改不影响已出账单（Bill.snapshot 固化计算依据）
- 订阅消息配额不足/用户未订阅 → NotifyLog 记 SKIPPED，不影响出账

## 11. 测试策略

- **单元测试（Jest）**：规则引擎 5 种类型 + 公式白名单安全 + 边界（0 面积、缺读数、分摊除不尽的分钱处理——按分排序补差，总额守恒）；出账幂等；绑定匹配
- **e2e（supertest + 独立 MySQL schema）**：认证、租户隔离（跨租户访问必须 404/403）、出账→查账→支付→状态流转全链路
- **验收脚本**：seed 脚本造 2 个租户 × 2 小区 × 若干房屋与规则，一键演示全流程
- 小程序端：微信开发者工具人工验收（提供验收清单）

## 12. 部署

- **本地**：`docker compose up` 起 mysql/redis，`pnpm dev` 起 api + admin；seed 数据一键导入
- **服务器**（第二批资料到位后）：同 compose 增加 api/admin 容器 + Caddy 自动 HTTPS；`.env` 管理密钥；MySQL 每日备份（mysqldump + cron）
