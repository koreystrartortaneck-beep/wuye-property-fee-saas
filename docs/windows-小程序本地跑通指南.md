# Windows 上跑通小程序端 —— 操作指南

给 Windows 上协助我的 AI：本文所有路径、AppID、环境 ID 都是**已经核对过的真实值**，
不要替换成占位符，也不要"猜测性地"改动 `apps/miniprogram/config.js` —— 那个文件已经是
生产就绪状态，改错会导致连不上后端。

---

## 0. 结论先说：不需要装 Node，也不需要"构建 npm"

这个小程序是**原生小程序**，没有任何 npm 依赖（已核实：`apps/miniprogram/` 下没有
`package.json`，代码里的 `require` 全部指向项目内的相对路径）。

所以：

- ❌ 不需要 `npm install`
- ❌ 不需要微信开发者工具里的「工具 → 构建 npm」
- ✅ 只需要：Git + 微信开发者工具

后端**已经部署在线上**（微信云托管），你本地不需要跑后端。小程序通过
`wx.cloud.callContainer` 走云托管内部通道访问它。

---

## 1. 装两个东西

| 软件 | 下载 | 说明 |
|---|---|---|
| Git for Windows | https://git-scm.com/download/win | 一路默认下一步即可 |
| 微信开发者工具（稳定版 Stable） | https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html | 选 **Windows 64** |

---

## 2. 拉代码

打开 **PowerShell**，执行：

```powershell
cd $HOME\Desktop
git clone https://github.com/koreystrartortaneck-beep/wuye-property-fee-saas.git
cd wuye-property-fee-saas
git log -1 --oneline
```

**仓库是私有的**，clone 时会弹窗要 GitHub 登录，用浏览器授权即可
（如果没弹窗而是报 `Authentication failed`，先执行 `git config --global credential.helper manager` 再重试）。

### 核对拉对了没有

`git log -1 --oneline` 输出的提交号应该是 **`5742f4b`** 或更新的提交。
如果比这个旧，执行 `git pull`。

再确认小程序配置是对的：

```powershell
Select-String -Path apps\miniprogram\config.js -Pattern "useCloud|cloudEnv|mockAuth|jvaB_jR2"
```

**必须**看到这四行（值要完全一致）：

```
useCloud: true,
cloudEnv: 'wuye-api-d2gql1e3g718d01c9',
mockAuth: false,
'jvaB_jR2VUolwxPk1MRV1by9d3Kg2AXyn21JdiIhFOk',
```

- `useCloud: true` —— 走云托管
- `mockAuth: false` —— 真实微信登录（不是假账号）
- 那串 `jvaB_...` —— 订阅消息模板 ID，**这次测试的重点就是它**

如果哪一项不对，说明代码没拉全或被改过，**先停下来问我**，不要自己改。

---

## 3. 用开发者工具打开

⚠️ **最容易踩的坑：不要打开仓库根目录。**

`project.config.json` 里没有设置 `miniprogramRoot`，意味着"项目根目录就是小程序根目录"。
所以必须打开的是 **`apps\miniprogram`** 这一层，不是 `wuye-property-fee-saas`。

1. 打开微信开发者工具，用**你自己的微信**扫码登录
2. 「小程序」→「导入项目」（不是"新建"）
3. 目录选：`C:\Users\<你的用户名>\Desktop\wuye-property-fee-saas\apps\miniprogram`
4. AppID：`wx9e8f35712e4bc1d3`（导入时会自动从 `project.config.json` 读到，核对一下就行）
5. 点「导入」

导入后左侧文件树顶层应该直接看到 `app.js`、`app.json`、`pages`、`utils`、`config.js`。
**如果看到的是 `apps`、`docs`、`packages` 这些，说明打开的层级错了**，退回第 3 步。

### 权限问题

你的微信必须是这个小程序的**开发者**（在微信公众平台「管理 → 成员管理」里）。
既然模板是你自己去公众平台配的，你应该是管理员，权限没问题。

---

## 4. 编译看首页

工具里点「编译」。正常应该：

- 模拟器里出现首页，底部有 4 个 tab：首页 / 服务 / 账单 / 我的
- 「调试器 → Console」里**没有红色报错**

### 如果首页数据是空的

不一定是坏了。看「调试器 → Network」里 `callContainer` 请求的返回：

| 现象 | 含义 |
|---|---|
| 返回 `code: 0` 但列表为空 | 正常 —— 你这个微信号还没绑定房屋 |
| 报 `云调用失败` / `callContainer` 报错 | 云托管权限问题，**告诉我，附上完整报错** |
| 报 `40029` / `登录失败` | 登录链路问题，**告诉我** |

---

## 5. 本次测试的唯一目标：拿到订阅授权

前面几轮我修完了通知链路上所有的问题（网络被劫持、投递任务从未运行、字段名全错等），
现在微信返回的是 `43101 user refuse to accept the msg` —— 意思是**你这个微信号没有订阅额度**。

因为在我填入模板 ID 之前，`subscribeTmplIds` 是空数组，代码里那句
`requestSubscribe()` 直接 return false，**从来没有真正向微信请求过授权**。

所以要你做的就是走一次真实授权。

### ⚠️ 必须用真机，不要用模拟器

模拟器里的订阅授权不一定真的在微信服务端登记额度。用真机：

1. 工具右上角点「**预览**」，生成二维码
2. 用**你自己的微信**扫码，在手机上打开小程序
3. 进入底部「**我的**」
4. 「服务中心」里找到「**缴费提醒**」（说明文字是"开启后账单生成与到期前微信提醒你"）
5. 点它 → 微信会弹订阅授权框 → 点「**允许**」
6. 应该看到 toast「已开启缴费提醒」

**如果弹框没出现，或者点了之后提示「未开启提醒」**：把手机上看到的完整文字发我。
（我在代码里留了补救路径提示：右上角 `···` → 设置 → 订阅消息）

### 然后告诉我

只要回我一句「授权好了」，我会立刻在后台触发一条催缴，然后查通知记录。

预期结果：
- 后台通知记录里状态从 `FAILED` 变成 **`SENT`**
- 你的**手机微信「服务通知」**里收到一条「缴费业务通知」，内容是：
  费用名称 / 金额 / 到期日期 / 温馨提示 四行

**在你手机真的收到之前，通知功能不算通。** 这是我这几轮反复吃到的教训——
测试全绿、接口返回 200，都不能证明功能真的在工作。

---

## 6. 提交审核（测试通过之后再做）

`config.js` 已经填好模板 ID，**必须重新上传才生效**。

1. 工具右上角「**上传**」
2. 版本号填 `1.0.0`，备注随便写（例如"接入缴费提醒"）
3. 到微信公众平台 → 「管理 → 版本管理」→ 找到刚上传的开发版 → 「提交审核」

注意「预览」和「上传」是两件事：预览只是在你手机上跑当前代码（测试用），
上传才会生成可提审的版本。

---

## 7. 可选：本地跑一遍小程序的测试

需要 Node 20+。不做也不影响上面任何步骤。

```powershell
cd $HOME\Desktop\wuye-property-fee-saas
node --test tests\miniprogram-labels.test.js tests\miniprogram-auth-flow.test.js tests\miniprogram-payment-flow.test.js tests\miniprogram-structure.test.js
```

预期 `# pass 52` / `# fail 0`。

---

## 附：给 AI 的注意事项

1. **不要修改 `apps/miniprogram/config.js`**。里面的 `cloudEnv`、`cloudService`、
   `mockAuth: false`、`subscribeTmplIds` 都是核对过的生产值。
2. **不要执行 `npm install`**，小程序目录没有 npm 依赖，装了反而可能触发工具要求"构建 npm"。
3. **不要改 `project.config.json`**。`urlCheck: false` 是故意的（走云托管不需要域名校验）。
4. `project.private.config.json` 不在仓库里（被 gitignore 了），开发者工具会自动生成，
   这是正常的，不要试图去创建它。
5. 如果开发者工具提示"当前项目未关联云开发环境"之类，**不要去创建新环境**——
   我们用的是**云托管**（CloudRun），环境 ID 已经写在 config.js 里了。
6. 遇到任何报错，优先把「调试器 → Console」和「Network」的原文抄下来给用户带回来，
   不要自行猜测原因去改代码。
