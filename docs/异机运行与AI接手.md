# 异机运行与 AI 接手手册

适用分支：`feat/property-staff-workspace`。这是物业人员小程序管理端改造候选版本，不是线上已发布版本。

最新调整（2026-09-07）：用户真机反馈后，视觉已恢复为改造前 `a37e5fc` 的管理端风格。以该版本原有渐变卡片、胶囊页签、按钮、房屋格子为基准，不再沿用首轮扁平化原型。新功能与分页保留。本轮视觉仍待用户真机确认。

收据页随后做了布局调整：筛选移入弹层、分页移到底部、标题与返回改为有安全区占位的自绘导航，长房号不与金额争空间。详情接口未部署的阻塞尚未解决，错误提示改清楚不代表功能已联通。见改造文档“收款收据页二次调整”。

## 1. 先明确边界

- 本次交付是代码、测试和文档入库；不合并 `main`，不部署后端，不上传或发布小程序。
- 仓库 CI 只检查；仓库部署文档注明微信云托管从 `main` 自动构建。因此推 `main` 可能影响生产，不能当成普通同步操作。
- `apps/miniprogram/config.js` 默认 `useCloud: true`、`mockAuth: false`，连接生产云托管。开发者工具里的本地代码也能修改生产数据，不能因为叫“预览”就试收款、退款、出账、催缴。
- 新收据、报修详情、部分发布需要本分支 API。旧线上后端不保证支持，404 不代表没有业务记录。部分发布使用独立新路径，避免旧后端忽略字段后整批发布。
- 本次未改数据库结构，不需要新增迁移；新电脑仍需应用仓库已有迁移建立本地库。
- 真实数据原型、生产数据库、令牌、私钥、个人 `.env` 不随仓库交付。不要复制生产库来造测试场景。

## 2. 拉取正确分支

新目录（macOS 终端或 Windows PowerShell）：

```sh
git clone --branch feat/property-staff-workspace --single-branch https://github.com/koreystrartortaneck-beep/wuye-property-fee-saas.git
cd wuye-property-fee-saas
git branch --show-current
git log -1 --oneline
```

已有仓库先执行 `git status`，有本地改动先保存，不要强制覆盖。干净时：

```sh
git fetch origin
git switch feat/property-staff-workspace
git pull --ff-only
```

若本地没有该分支且不能自动跟踪，使用 `git switch --track origin/feat/property-staff-workspace`。核对提交号与本次交付消息一致。

## 3. 仅编译小程序

原生小程序没有独立 npm 依赖。只编译页面需要 Git 和微信开发者工具，无需在小程序目录执行 npm install 或“构建 npm”。

1. 用有该小程序开发权限的微信登录开发者工具。
2. 导入 **`apps/miniprogram`**，不是仓库根目录。AppID 从 `project.config.json` 读取。
3. 若准备交互测试，先按下一节启动隔离 API 并修改本地连接配置，再编译；不要先连接生产试操作。
4. 本机私有配置不入库，开发者工具会生成。模拟器访问本地 HTTP 时，在本机开发设置中关闭合法域名校验。

只导入前端不等于新功能已经可用。不要照旧 Windows 指南直接上传、提审；那份文档是历史订阅通知专项任务。

## 4. 完整本地运行（推荐）

准备 Node.js 22、pnpm **11.4.0**（根 package.json 固定）、Docker。以下命令在仓库根目录执行：

```sh
corepack enable
pnpm --version
pnpm install --frozen-lockfile
docker compose up -d mysql
docker compose ps
pnpm --filter @pf/shared build
```

等待 MySQL healthy。若本机 3306 已被占用，先排查服务；不要停止不明数据库。确需改映射时同步修改本地 DATABASE_URL。

首次创建 `apps/api/.env`：macOS 用 `cp apps/api/.env.example apps/api/.env`；PowerShell 用 `Copy-Item apps/api/.env.example apps/api/.env`。已有文件不要覆盖。

在本地 `.env` 中核对以下值，只允许指向刚创建的本地库：

```dotenv
DATABASE_URL="mysql://root:root@localhost:3306/property_fee"
JWT_SECRET=dev-secret-change-me
NODE_ENV=development
WX_MODE=mock
PAY_MODE=mock
ALLOW_MOCK_PAYMENTS=true
TZ=Asia/Shanghai
PORT=3000
```

不要填写真实支付密钥、告警地址或生产数据库连接。终端如已有同名环境变量可能覆盖 `.env`，也需确认实际目标。

确认数据库是本地后执行（迁移和 seed 会写库）：

```sh
pnpm --filter @pf/api exec prisma generate
pnpm --filter @pf/api exec prisma migrate deploy
pnpm --filter @pf/api seed
pnpm --filter @pf/api dev
```

API 地址为 `http://127.0.0.1:3000/api/v1`。seed 是演示基础数据，不是完整的长列表、成功收款、退款、草稿批次验收数据。

另开终端可启动 Web 后台（可选）：

```sh
pnpm --filter @pf/admin dev
```

Web 默认 `http://localhost:5173`，开发代理到本地 3000。演示租户管理员 `yunjing / yunjing123`，另一租户 `demo / demo123`；仅用于本地 seed 数据，不能拿去登录生产。

### 切换小程序到本地

仅在测试电脑编辑 `apps/miniprogram/config.js` 的对应字段，其余保留：

```js
useCloud: false,
baseURL: 'http://127.0.0.1:3000/api/v1',
mockAuth: true,
subscribeTmplIds: [],
```

清除开发者工具里的本项目缓存后重新编译，避免生产令牌、房屋选择缓存混用。Network 中确认请求实际发往本地地址。

这属于测试机配置差异，不要提交覆盖生产默认配置。测试时指纹检查可能因配置变更而不一致；不要把本地测试配置连同重打的指纹推回仓库。

### 进入物业管理端

小程序不是 Web 账号密码登录：微信/模拟手机号匹配 `AdminUser.phone` 后换发管理令牌。仅有 seed 的用户名密码，不保证出现物业入口。

在隔离库中执行 `pnpm --filter @pf/api exec prisma studio`，给 seed 的 `yunjing` 管理员设置一个测试手机号，例如 `13900001111`，保持其租户及 ACTIVE 状态；不要改生产人员。小程序 mock 手机号输入同一测试号，进入“我的 → 物业管理”。没有入口时检查手机号、管理员状态、实际 API 地址及换发接口错误，不要绕过权限。

真机的 `127.0.0.1` 指手机自身，不是电脑；需改为同一局域网电脑地址或隔离测试服务，另核对防火墙、HTTP 调试限制。模拟器跑通后再做真机验证。

## 5. 项目地图与业务主线

| 目录 | 职责 |
| --- | --- |
| `apps/miniprogram/pages`、`utils` | 业主端、登录、请求、原电子收据 |
| `apps/miniprogram/packageAdmin` | 本轮物业人员管理端：楼盘图、欠费、报修、待发布、功能及详情 |
| `apps/admin` | Vue Web 后台；不是本轮整体视觉改造对象 |
| `apps/api/src/billing` | 计费、房屋标准、草稿、发布、欠费、催缴 |
| `apps/api/src/payment` | 支付、线下收款、退款、收据、对账 |
| `apps/api/src/tenant`、`auth` | 租户隔离与认证；管理权限还需检查各控制器守卫 |
| `apps/api/prisma` | 数据模型、迁移、演示 seed |
| `packages/shared`、`tests`、`tools` | 共享定义、前端守卫测试、预检和发布工具 |

维护主线：房屋资料与授权联系手机号 → 房屋收费标准 → 草稿账单 → 物业确认发布 → 业主支付/线下收款 → 收据 → 退款与对账。授权手机号、房屋绑定、当前选中房屋、账单发布状态是“业主看不到账单”排查的不同层次，不能随意新建账单解决。

金额用精确小数或整数分；统计区分成功、退款、关闭、草稿与欠费，明确北京时间日期口径。不能把当前页相加当总计，不能把退款单当有效实收。

## 6. 本轮必须保留的产品决定

- 沿用改造前线上样式，不再整体换肤；物业操作优先，重要操作固定底部且保留原按钮形状，长列表分页。
- “全部勾选”针对当前筛选结果的全部页，不是当前页。单户取消和返回页面要保留合理选择状态。
- 欠费催缴沿用单次最多 500 户限制；草稿发布后端选中 ID 上限 2000；这不是无限批量接口。
- 部分发布核对 ID 归属、草稿状态、总金额和幂等键；未选账单保留草稿，不能回退整批发布接口“兼容”。
- 收据复用原业主收据模板和不可变快照，退款作废；管理端不新增分享入口。
- 页面文案必须是正式业务用语，不加入原型说明、AI 提示、设计备注。必要错误和操作确认不能删。

关键新增位置：`packageAdmin/list.js`、`pages/receipts`、`pages/receipt`、`pages/batch-detail`、`pages/ticket-detail`、`utils/receipt-page.js`；服务端见 `bill-workflow.service.ts`、`admin-payment.controller.ts`、`payment.service.ts` 和 `admin-tickets.controller.ts`。

## 7. 验证与未验收项

仓库根目录执行：

```sh
node tools/check-secrets.mjs
node tools/miniprogram-preflight.mjs
node --test tests/*.test.js
pnpm --filter @pf/api exec jest --runInBand --silent
pnpm --filter @pf/api build
node tools/stamp-miniprogram.mjs --check
git diff --check
```

提交前本轮复跑：Node 243 项、Jest 93 组/993 项通过，API 构建、静态预检、指纹检查通过。此前微信自带 WXML/WXSS 编译器检查通过；**不等于模拟器或真机交互验收**。

尚需隔离环境验收：

1. 多楼栋、单元、车库长列表，搜索、翻页、页签返回、底部按钮及软键盘。
2. 欠费跨页全选、取消个别、筛选变化、返回刷新；500 户限制及失败重试。
3. 草稿部分发布、剩余草稿、金额变化拒绝、重复点击、断网后幂等重试；用真实本地 MySQL 验证事务与并发，不能以 mock 单测替代。
4. 线上/线下收款、退款作废、合并付款的房屋查询；两端同单收据一致，保存相册权限。
5. 跨租户访问拒绝、物业不同角色、报修图片及办结流程。seed 无完整场景时仅在隔离库补合成数据。

未完成：模拟器和真机全流程、真实数据库事务集成验收。未发布体验版或线上版。此前本机开发者工具 CLI 服务端口关闭；这不是其他电脑必然存在的问题。

## 8. 给接手 AI 的第一条任务

先读本文、`docs/物业管理端改造-20260907.md`，再按需读 `docs/项目说明书.md`、`docs/部署顺序与验证.md`、`docs/真机验证清单.md`、`docs/runbooks/支付退款对账处置.md`。旧文档中的日期、提交号和上线状态是历史记录，需重新核实。

先报告当前分支/提交、实际请求环境、数据库目标及能否进入物业管理端，再在隔离环境执行上述验收。记录复现步骤和真实结果；不要把编译通过写成业务验收通过。未获新授权不要合并 main、部署、上传、提审或操作生产财务数据。
