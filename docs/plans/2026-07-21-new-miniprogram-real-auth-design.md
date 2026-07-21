# 新小程序主体真实微信能力设计

## 目标

将新小程序主体接入现有微信云托管 NestJS 服务，完成真实微信登录、手机号快速验证、云存储和订阅授权基础链路；支付在本阶段继续使用 Mock。

## 现状

- 云托管 `wuye-api` 已部署，公网健康检查正常。
- 新 MySQL `property_fee` 已创建并应用全部 Prisma 迁移。
- 云托管当前从 GitHub `main` 自动部署，但远程 `RealWxService` 仍是占位实现。
- 本地工作区已有真实微信 API、手机号授权、隐私弹窗和订阅授权改动，尚未测试、提交和推送。
- 新 AppID 和云环境 ID 已写入本地配置；敏感值仅存在于 Git 忽略的部署配置中。

## 方案

### 后端

保留现有 JWT 和 `WxUser.openid` 身份模型。小程序调用 `wx.login` 获取临时 code，NestJS 使用微信 `jscode2session` 换取 openid，创建或读取 `WxUser` 并签发 7 天 JWT。手机号授权使用新版 `getPhoneNumber` 临时 code，经 access token 调用微信接口获取手机号，再按房屋预留手机号自动绑定。

`RealWxService` 负责微信接口协议；`WxCloudService` 负责 access token 缓存、云存储上传及临时 URL。环境缺失时应在调用微信前返回清晰错误，微信接口错误不得泄露 AppSecret。

### 小程序

`wx.cloud.init` 使用新环境 ID，`request.js` 继续通过 `wx.cloud.callContainer` 调用 `wuye-api`。正式配置将 `mockAuth` 设为 `false`，启动时调用 `wx.login`，绑定房屋页使用 `open-type="getPhoneNumber"`。隐私弹窗遵循微信隐私接口约束。

### 部署

先提交后端真实微信适配与测试并推送，触发云托管自动部署；健康检查通过后，用无效临时 code 验证返回值已从“未配置占位”变为真实微信 API 错误。再提交小程序 AppID、云环境 ID和真实授权 UI，使用微信开发者工具进行编译和真机验证。

## 错误处理

- 缺少 `WX_APPID` 或 `WX_SECRET`：返回配置错误，不发起微信请求。
- 微信登录 code 无效：返回未授权业务错误。
- 手机号 code 无效或过期：返回参数错误。
- 订阅模板未配置：记录跳过，不阻塞出账和支付。
- 云存储解析失败：记录警告并返回空映射，不影响主业务。

## 验证

- 后端单元测试覆盖真实登录、手机号、配置缺失和订阅模板缺失。
- 运行 API 全量单元测试和构建。
- 运行小程序 JSON/JS 静态检查。
- 云端验证 `/api/v1/health` 与 `/api/v1/auth/wx-login`。
- 微信开发者工具验证新 AppID、新云环境、真实登录和手机号授权。

## 回滚

云托管保留历史版本；后端异常时回滚到上一个云托管版本并将 `WX_MODE` 临时切回 `mock`。小程序在上传体验版前不影响线上旧版本。
