# 使用手册（业主篇 / 员工篇）

产物：`manual.pdf`（12 页，A4）。源文件：`manual.tex`，插图：`img/`。

## 重新编译

```bash
export PATH=/Library/TeX/texbin:$PATH
xelatex manual.tex && xelatex manual.tex      # 跑两遍，第二遍才有目录页码
```

需要 TeXLive 2023+（`ctex` / `tcolorbox` / `titlesec` / `fontspec`）。本机已装 TeXLive 2025。

## 换成真机截图

`img/` 里的图**取自当前代码渲染**，不是真机拍的。要换成真机截图：

1. 手机上截图，裁成 **宽 375 像素**（或任意等比宽度，排版按宽度对齐）；
2. 用**同名**覆盖 `img/` 里对应文件；
3. 重新编译 —— `manual.tex` 一个字都不用改。

文件名对应关系（`o-` = 业主端，`s-` = 员工端）：

| 文件 | 界面 |
|---|---|
| `o-mine-admin` | 我的（授权手机号后） |
| `o-bind` | 绑定房屋 |
| `o-bill` | 账单中心 |
| `o-bill-detail` | 账单详情（计算依据） |
| `o-ticket` | 报事报修（提交） |
| `s-entry` | 我的 → 物业工作入口 |
| `s-grid` | 楼盘图 |
| `s-arrears` | 欠费与催缴 |
| `s-house` | 房屋详情 · 账单 |
| `s-house-contacts` | 房屋详情 · 住户 |
| `s-house-info` | 房屋详情 · 信息 |
| `s-billone` | 给这户发账单 |
| `s-billing` | 批量出账 · 预览 |
| `s-batches` | 待发布批次 |
| `s-collect` / `s-collect-done` | 线下收款登记 / 收完 |
| `s-tickets` | 报事报修（员工） |
| `s-announce` | 发公告 |
| `s-housenew` | 新增房屋 |
| `s-staff` | 员工与权限 |

## 注意

- 插图里的手机号一律是 `138****1234` 这类**掩码或示例值**，没有真实号码 —— 手册会打印传阅。
- 界面文字改了之后，手册对应段落也要跟着改。以**手机上的文字为准**，那些提示是随功能一起写的。
