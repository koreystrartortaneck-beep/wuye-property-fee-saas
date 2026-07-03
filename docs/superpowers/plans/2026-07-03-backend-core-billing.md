# 后端核心 + 计费引擎 实施计划（子项目 1+2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成可本地运行的多租户物业费后端：认证、租户隔离、组织/房产/绑定管理、五类计费规则自动出账、Mock 支付闭环。

**Architecture:** pnpm monorepo 中的 NestJS 模块化单体；MySQL 单库共享表 + tenantId 行级隔离（CLS + Prisma Client Extension 强制注入）；出账以 BillRun/Bill 双唯一键保证幂等；微信与支付均为接口 + mock/real 双实现。

**Tech Stack:** Node 22, pnpm 11, NestJS 11, Prisma 6 (MySQL 8 via Docker), @nestjs/schedule, @nestjs/jwt, nestjs-cls, class-validator, bcryptjs, expr-eval, Jest + supertest。

## Global Constraints

- 依据 spec：`docs/superpowers/specs/2026-07-03-property-fee-saas-design.md`
- 金额：数据库 `DECIMAL(12,2)`；计算一律用**整数分**（int cents），出入口转换
- 所有租户域模型必须带 `tenantId` 且被 Prisma 扩展自动过滤，业务代码不得手写 tenantId 条件
- 响应统一 `{code, message, data}`；业务错误码定义于 `packages/shared`
- `WX_MODE=mock|real` 切换微信能力；本计划只实现 mock，real 留接口
- 时区 `TZ=Asia/Shanghai`（compose 与 .env 中固定）
- 每个 Task 结束必须：测试全绿 + git commit
- Redis 本阶段不使用（YAGNI）；compose 只起 MySQL

---

### Task 1: Monorepo 骨架 + Docker MySQL

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`(root), `tsconfig.base.json`, `docker-compose.yml`, `.env.example`
- Move: 现有小程序文件（`app.js` `app.json` `app.wxss` `sitemap.json` `project.config.json` `pages/`）→ `apps/miniprogram/`

**Interfaces:**
- Produces: `pnpm -r` 可用的 workspace；`docker compose up -d` 起 MySQL(3306, root/root, db=property_fee)

**Steps:**

- [ ] `pnpm-workspace.yaml`: packages: `apps/*`, `packages/*`
- [ ] root `package.json`: `"private": true`, scripts: `"dev": "pnpm --filter @pf/api dev"`, `"test": "pnpm -r test"`; `engines.node >=22`
- [ ] `tsconfig.base.json`: strict, ES2022, moduleResolution node16 之外用 NestJS 默认 commonjs 配置（target ES2022, experimentalDecorators, emitDecoratorMetadata, strict, skipLibCheck, paths `@pf/shared` → `packages/shared/src`）
- [ ] `docker-compose.yml`:

```yaml
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: property_fee
      TZ: Asia/Shanghai
    ports: ["3306:3306"]
    volumes: [mysql-data:/var/lib/mysql]
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
volumes:
  mysql-data:
```

- [ ] `.env.example`: `DATABASE_URL="mysql://root:root@localhost:3306/property_fee"`, `JWT_SECRET=dev-secret-change-me`, `WX_MODE=mock`, `WX_APPID=`, `WX_SECRET=`, `TZ=Asia/Shanghai`, `PORT=3000`
- [ ] `git mv` 小程序文件至 `apps/miniprogram/`（不改内容）
- [ ] 验证：`docker compose up -d && docker compose ps` 显示 mysql healthy/running；`pnpm -v` 正常
- [ ] Commit: `chore: monorepo 骨架 + MySQL compose，小程序迁入 apps/miniprogram`

### Task 2: shared 包（枚举 + 错误码）

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/enums.ts`, `packages/shared/src/error-codes.ts`

**Interfaces:**
- Produces: `ErrorCode` 常量表（`{ code:number; message:string }`）：`OK(0)`, `UNAUTHORIZED(40100)`, `FORBIDDEN(40300)`, `NOT_FOUND(40400)`, `VALIDATION(40000)`, `NO_BINDING(41001)`, `BINDING_EXISTS(41002)`, `PHONE_REQUIRED(41003)`, `RULE_PARAM_INVALID(42001)`, `METER_READING_BACKWARD(42002)`, `METER_READING_MISSING(42003)`, `SHARE_POOL_MISSING(42004)`, `FORMULA_INVALID(42005)`, `BILL_NOT_PAYABLE(43001)`, `PAYMENT_STATE_INVALID(43002)`, `INTERNAL(50000)`
- Produces: 枚举字符串联合类型：`HouseType('RESIDENCE'|'PARKING'|'SHOP')`, `RuleType('AREA_PRICE'|'FIXED'|'METER'|'SHARE'|'FORMULA')`, `RulePeriod('MONTHLY'|'QUARTERLY'|'YEARLY')`, `MeterType('WATER'|'ELEC'|'GAS')`, `BillStatus`, `PaymentStatus`, `BindingStatus`, `AdminRole`, `NotifyType` —— 值与 spec §5 一致
- 仅类型与常量，无运行时依赖；api 通过 tsconfig paths 引用

**Steps:**

- [ ] 写包骨架与上述内容（一个纯导出模块，无需测试框架，`tsc --noEmit` 通过即可）
- [ ] 验证：`pnpm --filter @pf/shared exec tsc --noEmit`
- [ ] Commit: `feat(shared): 枚举与错误码`

### Task 3: NestJS 骨架（配置/统一响应/异常过滤器/健康检查）

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/nest-cli.json`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/common/response.interceptor.ts`, `apps/api/src/common/http-exception.filter.ts`, `apps/api/src/common/biz.exception.ts`, `apps/api/src/health.controller.ts`
- Test: `apps/api/test/health.e2e-spec.ts`

**Interfaces:**
- Produces: `BizException(errorCode: {code,message}, extra?: string)`；全局响应包装 `{code:0,message:'ok',data}`；异常 → `{code,message}`（HTTP 始终 200，业务码表达错误；参数校验错 code=40000）
- Produces: `GET /api/v1/health` → `{code:0,data:{status:'up'}}`

**Steps:**

- [ ] 安装依赖：`@nestjs/{core,common,platform-express,config,testing}@^11 rxjs reflect-metadata class-validator class-transformer`；dev: `typescript ts-node ts-jest jest @types/jest supertest @types/supertest @nestjs/cli`
- [ ] `main.ts`: `setGlobalPrefix('api/v1')`，全局 ValidationPipe(`whitelist:true, transform:true`)，注册 interceptor/filter
- [ ] 失败测试：e2e 请求 `/api/v1/health` 断言响应结构；运行确认失败
- [ ] 实现 → 测试通过
- [ ] Commit: `feat(api): NestJS 骨架与统一响应协议`

### Task 4: Prisma schema 全量 + 迁移

**Files:**
- Create: `apps/api/prisma/schema.prisma`, `apps/api/src/prisma/prisma.module.ts`, `apps/api/src/prisma/prisma.service.ts`
- Test: `apps/api/test/prisma.spec.ts`（连库建/查一条 Tenant）

**Interfaces:**
- Produces: spec §5 全部模型。要点：
  - 所有 id 用 `String @id @default(cuid())`
  - 唯一键：`House(communityId,code)`, `HouseBinding(wxUserId,houseId)`, `MeterReading(houseId,meterType,period)`, `SharePool(ruleId,period)`, `BillRun(ruleId,period)`, `Bill(ruleId,houseId,period)`, `Payment.orderNo`, `WxUser.openid`, `AdminUser.username`, `Tenant.code`
  - 金额字段 `Decimal @db.Decimal(12,2)`；`House.area Decimal? @db.Decimal(10,2)`
  - `FeeRule.params Json`、`Bill.snapshot Json`、`BillRun.skippedDetail Json?`
  - 枚举用 Prisma enum，取值与 shared 一致
  - 带 `tenantId` 的模型：Community, House, HouseBinding(冗余存 tenantId), FeeRule, MeterReading, SharePool, BillRun, Bill, Payment, NotifyLog, AdminUser(可空)
- Produces: `PrismaService extends PrismaClient`（onModuleInit $connect）

**Steps:**

- [ ] 写 schema → `pnpm prisma migrate dev --name init`
- [ ] 失败测试 → 实现 PrismaModule → 通过
- [ ] Commit: `feat(api): 数据模型与初始迁移`

### Task 5: 租户上下文 + Prisma 租户隔离扩展

**Files:**
- Create: `apps/api/src/tenant/tenant-cls.ts`（nestjs-cls 配置 + `getTenantId()/runWithTenant()`）, `apps/api/src/tenant/tenant-extension.ts`
- Modify: `prisma.service.ts`（应用 extension）
- Test: `apps/api/src/tenant/tenant-extension.spec.ts`

**Interfaces:**
- Produces: `runWithTenant(tenantId, fn)`；Prisma `$extends` query 拦截：对 TENANT_MODELS 列表内模型的 `find*/count/aggregate/update*/delete*` 自动 AND `{tenantId}`，`create/createMany/upsert` 自动写入 `tenantId`；上下文缺租户时：读→强制空结果（`tenantId: '__none__'`），写→抛 `BizException(FORBIDDEN)`；`runWithTenant(null)`（超管平台视角）与非租户模型不受影响
- Produces: `prisma.raw`（未扩展的原始 client，仅 seed/测试用）

**Steps:**

- [ ] 失败测试（真库）：租户 A 上下文建 Community；A 可查到、B 查不到；B 上下文 update A 的记录 count=0；无上下文 create 抛错
- [ ] 实现 extension → 通过
- [ ] Commit: `feat(api): 租户行级隔离（CLS + Prisma extension）`

### Task 6: 微信服务双模式 + 业主认证

**Files:**
- Create: `apps/api/src/wx/wx.service.ts`(接口+token), `apps/api/src/wx/wx.mock.ts`, `apps/api/src/wx/wx.real.ts`(占位:抛"未配置"), `apps/api/src/wx/wx.module.ts`, `apps/api/src/auth/auth.module.ts`, `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/auth.controller.ts`, `apps/api/src/auth/jwt.strategy.ts`(手写 Guard，见 Task 7), DTOs
- Test: `apps/api/test/auth.e2e-spec.ts`

**Interfaces:**
- Produces: `interface WxApi { code2session(code): Promise<{openid:string}>; getPhoneNumber(code): Promise<{phone:string}>; sendSubscribeMessage(msg): Promise<{ok:boolean; error?:string}> }`，DI token `WX_API`，`WX_MODE=mock` 时绑定 Mock：`code2session('mock:abc')→{openid:'abc'}`（非 mock: 前缀报 40000）、`getPhoneNumber('phone:13800138000')→{phone:'13800138000'}`
- Produces:
  - `POST /api/v1/auth/wx-login {code}` → `{token, user:{id, hasPhone}}`（upsert WxUser；owner JWT payload `{sub, typ:'owner'}`，7d）
  - `POST /api/v1/auth/phone {code}`（owner 鉴权）→ 存 phone → **自动匹配**：全库 `House.ownerPhone==phone` 的房，逐个 upsert `HouseBinding{relation:'OWNER',status:'ACTIVE',source:'PHONE_MATCH', tenantId: house.tenantId}` → 返回 `{phone, matchedHouses:number}`。注意：此流程跨租户，使用 `prisma.raw`（业主天然跨租户，spec §6.2）
- Produces: `AuthService.signOwnerToken(userId)`, `verifyToken(token)`

**Steps:**

- [ ] 失败 e2e：wx-login 建号返 token → phone 授权 → 断言绑定生成（预置一条 House.ownerPhone 匹配）
- [ ] 实现 → 通过；Commit: `feat(api): 业主微信登录与手机号自动绑定（mock 双模式）`

### Task 7: 守卫体系 + 管理端登录

**Files:**
- Create: `apps/api/src/auth/owner.guard.ts`, `apps/api/src/auth/admin.guard.ts`, `apps/api/src/auth/roles.decorator.ts`, `apps/api/src/auth/current.decorator.ts`, `apps/api/src/admin/admin-auth.controller.ts`(+service)
- Test: `apps/api/test/admin-auth.e2e-spec.ts`

**Interfaces:**
- Produces: `POST /api/v1/admin/auth/login {username,password}` → `{token, profile:{name,role,tenantId}}`（bcryptjs 校验，admin JWT `{sub, typ:'admin', tenantId, role}`，12h）
- Produces: `AdminGuard`：验 JWT.typ==='admin'，将 tenantId 写入 CLS（`runWithTenant`）；SUPER_ADMIN 可用 `X-Tenant-Id` 头覆盖；`@Roles('TENANT_ADMIN')` + RolesGuard；`OwnerGuard`：typ==='owner'，注入 `req.ownerId`，**不设租户上下文**（owner 接口用 raw + 绑定校验）
- Produces: `@Current()` 参数装饰器 → `{ownerId}` 或 `{adminId, tenantId, role}`

**Steps:**

- [ ] 失败 e2e：错密码 40100；STAFF 访问 @Roles(TENANT_ADMIN) 接口 40300；租户 A 管理员查 B 资源得空
- [ ] 实现 → 通过；Commit: `feat(api): 管理端登录与双端守卫`

### Task 8: 管理端组织 CRUD（租户/小区/房产/导入/绑定审核）

**Files:**
- Create: `apps/api/src/admin/tenants.controller.ts`(+service, 仅 SUPER_ADMIN：创建租户时同时建 TENANT_ADMIN 账号), `apps/api/src/admin/communities.controller.ts`, `apps/api/src/admin/houses.controller.ts`, `apps/api/src/admin/bindings.controller.ts`, 对应 service 与 DTO
- Test: `apps/api/test/admin-org.e2e-spec.ts`

**Interfaces:**
- Produces（全部 `/api/v1/admin` 前缀，AdminGuard）：
  - `POST/GET/PATCH /tenants`（SUPER_ADMIN）；`POST /tenants` body 含 `{name,code,adminUsername,adminPassword}`
  - `POST/GET/PATCH /communities`
  - `POST/GET/PATCH /houses`（query: communityId, type, keyword, page）；`POST /houses/import` body `{communityId, rows: Array<{type,building?,unit?,room?,code,displayName,area?,ownerName?,ownerPhone?}>}` → 逐行 upsert（唯一键 communityId+code），返回 `{created, updated, failed:[{index,reason}]}`（CSV 解析由前端做，spec §8）
  - `GET /bindings?status=PENDING`；`POST /bindings/:id/review {approve:boolean, rejectReason?}` → ACTIVE/REJECTED
- houses.service `create/import` 校验 area：type=RESIDENCE 必填>0

**Steps:**

- [ ] 失败 e2e：建租户→建小区→导入 3 行（1 行坏数据）→断言 created=2/failed=1→审核一条 PENDING 绑定
- [ ] 实现 → 通过；Commit: `feat(api): 管理端组织与房产管理`

### Task 9: 业主端查询与绑定申请

**Files:**
- Create: `apps/api/src/owner/owner-houses.controller.ts`(+service), `apps/api/src/owner/lookup.controller.ts`
- Test: `apps/api/test/owner-houses.e2e-spec.ts`

**Interfaces:**
- Produces（`/api/v1/owner`，OwnerGuard，实现层用 `prisma.raw` + 绑定校验）：
  - `GET /communities?keyword=` → 全租户搜索小区（含 tenantName）
  - `GET /communities/:id/houses?building=&keyword=` → 供申请选择（只返回 code/displayName，不泄漏业主信息）
  - `POST /bindings {houseId, relation, applicantName}` → PENDING（重复绑定 41002）
  - `GET /my/houses` → ACTIVE 绑定的房屋列表
- Produces: `OwnerHousesService.assertOwnerHouse(ownerId, houseId)` → 无 ACTIVE 绑定抛 41001（后续账单/支付复用）

**Steps:**

- [ ] 失败 e2e：申请→PENDING 不可见账单→审核通过→my/houses 可见
- [ ] 实现 → 通过；Commit: `feat(api): 业主绑定申请与房屋查询`

### Task 10: 计费引擎（纯函数）

**Files:**
- Create: `apps/api/src/billing/engine/money.ts`, `apps/api/src/billing/engine/calc.ts`, `apps/api/src/billing/engine/share.ts`, `apps/api/src/billing/engine/formula.ts`, `apps/api/src/billing/engine/rule-params.ts`(zod 或手写校验各 ruleType 的 params)
- Test: 同目录 `*.spec.ts`（纯单测，不连库）

**Interfaces:**
- Produces `money.ts`: `toCents(s: string|Decimal): number`, `centsToStr(c: number): string`（四舍五入到分）
- Produces `calc.ts`:

```ts
type CalcInput = { ruleType: RuleType; params: any;
  house: { id: string; area: string | null };
  readingDiff?: number | null };          // METER 用，单位与表一致
type CalcResult = { ok: true; cents: number; snapshot: Record<string, unknown> }
                | { ok: false; skipReason: string };
export function calcOne(input: CalcInput): CalcResult
```
  - AREA_PRICE：area 缺失 → skip `'AREA_MISSING'`；snapshot `{unitPrice, area}`
  - FIXED：snapshot `{amount}`
  - METER：readingDiff 为 null → skip `'METER_READING_MISSING'`；snapshot `{unitPrice, readingDiff, meterType}`
  - FORMULA：委托 formula.ts；变量白名单 `area` + params.vars；结果非有限数/负数 → skip `'FORMULA_INVALID'`
  - SHARE 不走 calcOne（批量），calcOne 收到 SHARE 抛程序错误
- Produces `share.ts`: `allocateShare(totalCents: number, houses: {id:string; area:string|null}[], shareBy:'AREA'|'HOUSE'): { alloc: Map<string, number>; skipped: string[] }`
  - BY_AREA：无面积的房进 skipped；按面积比例分，**最大余数法**补差，`sum(alloc)===totalCents` 恒成立
  - BY_HOUSE：均分 + 最大余数
- Produces `formula.ts`: `evalFormula(expr: string, scope: Record<string, number>): number`（expr-eval Parser，禁 `functions`/赋值；异常上抛 FormulaError）
- Produces `rule-params.ts`: `validateRuleParams(ruleType, params): void`（不合法抛 BizException 42001/42005，FORMULA 时试算 `area=100` 验证表达式可求值）

**Steps:**

- [ ] 失败单测（关键用例，全部写出）：
  - AREA_PRICE: 2.5×128=320.00→32000 分；面积 null→skip
  - FIXED: 360→36000
  - METER: 0.6×(1234.5−1200.3)=20.52→2052；diff null→skip；diff 负数在录入层已挡，引擎按 0 处理并 snapshot 记录
  - FORMULA: `area*price*0.9, vars{price:2.5}, area=100` →225.00；`1/0`→skip；表达式含 `pow(2,3)` 函数调用→validateRuleParams 抛 42005
  - allocateShare BY_AREA: total=100.01 元分给面积 [50,30,20] 三户→三户合计恰好 10001 分；含一户 area=null→进 skipped
  - allocateShare BY_HOUSE: 100 元 3 户→[3334,3333,3333]
  - money: `toCents('2486.80')===248680`; `centsToStr(2052)==='20.52'`
- [ ] 实现 → 全绿；Commit: `feat(api): 计费引擎纯函数（五类规则+公式白名单+分摊守恒）`

### Task 11: 规则/抄表/公摊 API

**Files:**
- Create: `apps/api/src/billing/fee-rules.controller.ts`(+service), `apps/api/src/billing/meter.controller.ts`(+service), `apps/api/src/billing/share-pool.controller.ts`(+service), DTOs
- Test: `apps/api/test/billing-config.e2e-spec.ts`

**Interfaces:**
- Produces（`/api/v1/admin`）：
  - `POST/GET/PATCH /fee-rules`（创建/修改时跑 `validateRuleParams`；PATCH 可改 enabled/params/billDay/dueDays）
  - `POST /meter-readings {houseId, meterType, period, value}` → 取上期（同 house+meterType 的最大 period < 本期）作 prevValue 快照；`value < prevValue` 抛 42002；`GET /meter-readings?communityId&period&meterType` 返回含未录房屋列表（供后台补录）
  - `PUT /share-pools {ruleId, period, totalAmount}`（upsert）
- Produces: `MeterService.getDiff(houseId, meterType, period): number|null`（供出账用）

**Steps:**

- [ ] 失败 e2e：建 4 类规则（含坏 params 被拒）→录抄表（含回退被拒 42002）→录公摊
- [ ] 实现 → 通过；Commit: `feat(api): 收费规则、抄表与公摊录入`

### Task 12: 出账服务（幂等批次）

**Files:**
- Create: `apps/api/src/billing/bill-run.service.ts`, `apps/api/src/billing/bill-run.controller.ts`(admin: `POST /bill-runs {ruleId, period}` 手动触发/重跑、`GET /bill-runs`、`GET /bills` 查询、`POST /bills/:id/cancel`)
- Test: `apps/api/test/bill-run.e2e-spec.ts`

**Interfaces:**
- Produces: `BillRunService.generate(ruleId, period): Promise<{generated:number; skipped:number}>`
  1. `billRun.upsert`（唯一键 ruleId+period；已 DONE 也允许重跑）状态 RUNNING
  2. 圈定：规则所在 community 内 `status=ACTIVE` 且 `type===rule.houseType` 的房
  3. SHARE：查 SharePool（缺→批次 FAILED, skippedDetail `{reason:'SHARE_POOL_MISSING'}`）→ `allocateShare`；其他类型逐户 `calcOne`（METER 先 `MeterService.getDiff`）
  4. 逐户 `bill.create`，撞唯一键 `(ruleId,houseId,period)` 视为已存在跳过（catch P2002）→ **重跑只补缺**
  5. `dueDate = 出账日 + rule.dueDays`；title = `${rule.name} ${period}`；snapshot 存计算依据
  6. 更新 BillRun：DONE + 统计 + skippedDetail（数组 `{houseId, code, reason}`）
  7. 每张新账单调用 `NotifyService.enqueueBillCreated(bill)`（Task 14 提供；本 Task 先注入接口打日志的临时实现亦可——不，直接在 Task 14 前留接口：定义 `NOTIFY_SERVICE` token + noop 实现，Task 14 替换）
- Produces: `POST /bills/:id/cancel` → 仅 UNPAID 可作废 → CANCELED

**Steps:**

- [ ] 失败 e2e：AREA_PRICE 规则 3 房（1 房无面积）→ generated=2, skipped=1；**重跑 generated=0**；补面积后重跑 generated=1；SHARE 规则缺池 FAILED，补池后 DONE 且总额守恒
- [ ] 实现 → 通过；Commit: `feat(api): 幂等出账批次与账单管理`

### Task 13: 定时任务（出账日 + 到期/逾期提醒扫描）

**Files:**
- Create: `apps/api/src/billing/schedule.service.ts`, `apps/api/src/billing/period.ts`
- Test: `apps/api/src/billing/period.spec.ts`, `apps/api/src/billing/schedule.service.spec.ts`（mock prisma/billRunService，注入固定"今天"）

**Interfaces:**
- Produces `period.ts`（纯函数）: `currentPeriod(date: Date, period: RulePeriod): string | null` —— MONTHLY→`'2026-07'`；QUARTERLY 仅 1/4/7/10 月返回 `'2026-Q3'` 否则 null；YEARLY 仅 1 月返回 `'2026'`
- Produces `ScheduleService`:
  - `@Cron('0 0 2 * * *')` `runDailyBilling(now = new Date())`：遍历所有租户（`prisma.raw.tenant`）→ `runWithTenant` → enabled 且 `billDay===now.getDate()` 且 `currentPeriod(now, rule.period)!==null` 的规则 → `generate(rule.id, period)`；单条规则异常 catch 记日志不中断其余
  - `@Cron('0 0 9 * * *')` `runReminders(now)`：UNPAID 且 `dueDate` 在 3 天后当天 → DUE_SOON；UNPAID 且 `dueDate < now` → OVERDUE；借 NotifyLog 唯一性（查询该 bill+type 是否已 SENT）保证每类只发一次

**Steps:**

- [ ] 失败单测：period 边界（7 月 QUARTERLY→'2026-Q3'，8 月→null，1 月 YEARLY→'2026'）；runDailyBilling 只挑中 billDay 匹配规则；reminder 不重发
- [ ] 实现 → 通过；Commit: `feat(api): 每日自动出账与催缴扫描`

### Task 14: 通知模块

**Files:**
- Create: `apps/api/src/notify/notify.module.ts`, `apps/api/src/notify/notify.service.ts`
- Modify: bill-run.service / schedule.service 注入替换 noop
- Test: `apps/api/test/notify.e2e-spec.ts`

**Interfaces:**
- Produces: `NotifyService.send(type: NotifyType, bill: Bill): Promise<void>` —— 找 bill.houseId 的 ACTIVE 绑定用户 → 每人经 `WX_API.sendSubscribeMessage`（mock 恒 ok）→ 写 NotifyLog（SENT/FAILED/SKIPPED）；无绑定用户 → SKIPPED 一条（wxUserId 置空需 schema 允许：NotifyLog.wxUserId 可空——Task 4 已定义为可空？若未定义，本 Task 加迁移改可空）
- `GET /api/v1/admin/notify-logs?billId=&type=&page=`

**Steps:**

- [ ] 失败 e2e：出账后 NotifyLog 有 BILL_CREATED 记录且指向绑定用户
- [ ] 实现 → 通过；Commit: `feat(api): 出账/催缴通知（mock 通道）`

### Task 15: 支付模块（Mock 闭环）

**Files:**
- Create: `apps/api/src/payment/payment.module.ts`, `apps/api/src/payment/provider.ts`(接口+token), `apps/api/src/payment/mock.provider.ts`, `apps/api/src/payment/payment.service.ts`, `apps/api/src/payment/owner-payment.controller.ts`
- Test: `apps/api/test/payment.e2e-spec.ts`

**Interfaces:**
- Produces `provider.ts`:

```ts
interface PaymentProvider {
  createOrder(p: { orderNo: string; totalCents: number; description: string;
                   payerOpenid: string; tenantId: string }): Promise<Record<string, unknown>>; // 前端支付参数
  close(orderNo: string): Promise<void>;
}
```
- Produces（`/api/v1/owner`，OwnerGuard）：
  - `POST /payments {billIds: string[]}` → 校验：非空、全部属于本人 ACTIVE 绑定房屋、全部 UNPAID、不被其他 CREATED 订单占用（查 PaymentBill join Payment.status=CREATED）→ 建 Payment(CREATED, orderNo=`WY${yyyyMMdd}${6位随机}`) + PaymentBill → provider.createOrder → 返回 `{orderNo, payParams}`
  - `POST /payments/:orderNo/mock-confirm`（仅 `PAY_MODE=mock` 注册此路由）→ **事务**：Payment CREATED→SUCCESS + paidAt；关联 Bill 全部 UNPAID→PAID+paidAt+paymentId；重复调用幂等返回成功；Payment 非 CREATED 且非 SUCCESS 抛 43002
  - `GET /payments?page=` 本人缴费记录（含账单明细）；`GET /payments/:orderNo`
  - `GET /owner/bills?houseId=&status=&page=`、`GET /owner/bills/summary?houseId=` → `{unpaidTotal, unpaidCount}`（首页大数字用）
- 支付成功后（同事务外）触发无异常即可，不发通知（YAGNI）

**Steps:**

- [ ] 失败 e2e 全链路：出账→owner 查 unpaid summary→合并 3 张下单→mock-confirm→账单 PAID、summary 归零→重复 confirm 幂等→已 PAID 账单再下单被拒 43001
- [ ] 实现 → 通过；Commit: `feat(api): Mock 支付闭环与业主账单查询`

### Task 16: Seed 演示数据 + 全流程验收脚本 + README

**Files:**
- Create: `apps/api/prisma/seed.ts`, `apps/api/README.md`, root `README.md`
- Modify: `apps/api/package.json`（prisma.seed 配置, script `seed`）

**Interfaces:**
- Produces seed（用 `prisma.raw`）：平台超管 `admin/admin123`；租户「云璟物业」(admin: `yunjing/yunjing123`) → 小区「云璟公馆」→ 8 栋若干住宅（含 8-1-2602, 128㎡, 林悦 13800138000）+ 车位 B2-118 → 4 条规则（物业费 2.5 元/㎡/月 billDay=1、车位 360 固定、水费 METER、公摊 SHARE BY_AREA）；第二租户「示例物业」最小数据（验证隔离）；幂等（upsert）
- Produces README：环境要求、`docker compose up -d` → `pnpm install` → `migrate dev` → `seed` → `pnpm dev`、mock 约定（`mock:` code、`phone:` code、mock-confirm）、账号表、验收步骤清单

**Steps:**

- [ ] 写 seed → 跑两遍确认幂等
- [ ] 手动验收（curl 或 REST 脚本）：admin 登录→手动触发出账→wx-login→phone 绑定→查账单→支付→PAID
- [ ] 全量 `pnpm -r test` 绿
- [ ] Commit: `feat(api): seed 演示数据与 README 验收指引`

---

## Self-Review 结论

- **Spec 覆盖**：§5 全模型（T4）；§6.1 认证（T6/T7）；§6.2 隔离（T5/T7）；§6.3 出账（T12/T13）；§6.4 支付（T15）；§6.5 双模式（T6）；§7 协议（T3）；§10 边界（幂等 T12、并发占用 T15、抄表回退 T11、snapshot T12、通知降级 T14）；§11 测试（各 Task 内嵌 + T16 验收）。管理后台 UI（§8）与小程序（§9）属子项目 3/4，不在本计划。
- **类型一致性**：`calcOne/allocateShare/currentPeriod/generate/assertOwnerHouse` 的签名在消费方 Task 中按 Produces 引用一致。
- **遗留决策**：NotifyLog.wxUserId 需可空（T4 建 schema 时直接定为可空，T14 的备注即失效）。
