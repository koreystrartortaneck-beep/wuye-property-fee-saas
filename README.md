# 物业费缴纳 SaaS 系统

多租户物业费系统：业主微信小程序 + 物业 Web 管理后台 + NestJS 后端。
设计文档见 `docs/superpowers/specs/`，产品负责人待办见 `docs/需要你做的事.md`。

## 仓库结构

```
apps/
  api/          NestJS 后端（多租户、计费引擎、自动出账、Mock 支付）
  admin/        物业 Web 管理后台（子项目 3）
  miniprogram/  业主微信小程序
packages/
  shared/       共享枚举与错误码
```

## 快速开始（本地）

要求：Node ≥ 22、pnpm ≥ 9、Docker。

```bash
docker compose up -d          # MySQL 8（root/root, db=property_fee）
pnpm install
pnpm --filter @pf/shared build
cd apps/api
cp ../../.env.example .env    # 首次
pnpm exec prisma migrate dev  # 建表
pnpm seed                     # 演示数据（幂等）
pnpm dev                      # http://localhost:3000/api/v1
```

**Web 管理后台**（另开终端）：

```bash
pnpm --filter @pf/admin dev   # http://localhost:5173（/api 代理到 :3000）
```

**小程序**：微信开发者工具导入 `apps/miniprogram`（游客模式即可，域名校验已在私有配置关闭）。

## 演示账号

| 角色 | 账号 | 密码 |
|---|---|---|
| 平台超管 | admin | admin123 |
| 云璟物业管理员 | yunjing | yunjing123 |
| 示例物业管理员 | demo | demo123 |

业主端（mock 模式约定）：
- 微信登录 code：`mock:<任意串>`（如 `mock:linyue`）
- 手机号授权 code：`phone:<手机号>`（`phone:13800138000` 可自动绑定林悦的 3 处房产）
- 支付：下单后调 `POST /owner/payments/:orderNo/mock-confirm`

## 关键机制

- **多租户隔离**：所有租户域表带 `tenantId`，Prisma Client Extension 自动注入过滤（`src/tenant/`），业务代码写不出跨租户查询
- **计费规则**：单价×面积 / 固定金额 / 抄表计量 / 公摊分摊（最大余数法守恒）/ 自定义公式（expr-eval 白名单，禁函数调用）
- **自动出账**：每日 02:00 扫描 `billDay` 命中的启用规则；`BillRun(ruleId,period)` 与 `Bill(ruleId,houseId,period)` 双唯一键保证幂等，重跑只补缺
- **催缴**：每日 09:00 扫描，到期前 3 天与逾期各提醒一次（NotifyLog 去重）
- **微信/支付双模式**：`WX_MODE` / `PAY_MODE` 环境变量切换 mock/real，本地全流程可测

## 测试

```bash
cd apps/api
pnpm test        # 单元测试（计费引擎、账期、调度）
pnpm test:e2e    # e2e（需 MySQL 运行；认证/隔离/出账/支付全链路）
```

## 环境变量（apps/api/.env）

见 `.env.example`。生产环境必须更换 `JWT_SECRET`。

## 子项目进度

- [x] 1. 后端核心（多租户/认证/组织管理）
- [x] 2. 计费引擎与自动出账 + Mock 支付
- [x] 3. Web 管理后台（看板/组织/计费配置/出账/审核/通知）
- [x] 4. 小程序接入真实 API（含账单详情/申请进度/逾期标识）
- [x] 5. 服务器部署（用户自有服务器 + 体验版，见 docs/需要你做的事.md）
- [x] 6. 二期社区功能：报事报修（工单+图片+评分）/ 投诉建议 / 社区公告 / 访客通行码 / 电子收据 / 联系管家
- [ ] 7. 微信支付（服务商模式）与订阅消息 —— 等企业主体/商户资料
- [ ] 8. 正式版发布 —— 等备案域名 + 443 入口（云中转）
