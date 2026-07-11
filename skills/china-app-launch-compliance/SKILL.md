---
name: china-app-launch-compliance
description: Use when assessing mainland China launch, filing, licensing, privacy, payment, or store-review requirements for WeChat Mini Programs and iOS or Android apps, especially property-fee collection products.
---

# 中国软件与小程序上架合规

## 原则

把功能和实际业务链路映射为条件化要求。区分法律法规、行政备案、行政许可、平台规则和风控建议；不得输出一张不问业务事实的“万能证照清单”。本 skill 提供排查意见，不构成正式法律意见。

## 审查流程

1. 收集事实：发布地区、运营主体、开发者/备案/商户主体、目标平台、功能、收费模式、资金流、开票方、个人信息、权限、SDK、云服务和未成年人场景。
2. 对收费产品画出 `付款人 → 支付通道 → 商户号 → 结算账户 → 最终收款方 → 退款方/开票方`。
3. 按场景加载参考资料：
   - 所有项目：读取 `references/evidence-and-sources.md`、`references/mainland-general.md`。
   - 微信小程序：读取 `references/wechat-miniprogram.md`。
   - iOS/Android：读取 `references/ios-android-app.md`，并明确每个目标商店。
   - 处理用户数据：读取 `references/privacy-and-data.md`。
   - 收费、代收或分账：读取 `references/payment-and-settlement.md`。
   - 物业费项目：必须读取 `references/property-fee-project.md`。
4. 对每个拟下结论事项联网核验现行官方来源；记录页面标题、发布机关、链接、发布日期/生效日期、核验日期。平台后台可见规则要求用户提供截图或导出件。
5. 把结论标为：`必须`、`条件触发`、`建议`、`待确认`、`不适用`。事实不足时不得把“待确认”升级为“必须”。
6. 使用 `assets/compliance-report-template.md` 输出报告。

## 判定纪律

- 备案不等于许可；营业执照经营范围不等于取得专项许可。
- 平台审核通过不等于业务当然合法；APP备案也不代表内容或经营行为获认可。
- “有支付功能”不自动等于需要自持支付牌照；先查是否仅接入持牌机构、谁是特约商户、资金是否直接结算给真实交易收款方。
- 不凭产品名称判断业务性质。以实际功能、合同关系、资金流、数据流和面向对象为准。
- 不编造法条、文号、主管机关、证照名称或平台材料。无法从官方来源确认时写明未知项。
- 全国规则与地方物业收费规则并存时，要求确认项目所在地，并核验当地现行规定。

## 最低输出质量

每条合规矩阵至少包含：事项、结论类别、触发条件、责任主体、证照/材料或整改动作、提交/办理位置、依据及核验日期、缺失风险、当前证据、下一步。报告末尾列出缺失事实、来源登记和需律师/主管机关/平台人工确认的问题。
