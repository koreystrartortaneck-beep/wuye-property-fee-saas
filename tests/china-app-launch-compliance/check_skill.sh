#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
skill="$repo_root/skills/china-app-launch-compliance"

required_files=(
  "$skill/SKILL.md"
  "$skill/references/evidence-and-sources.md"
  "$skill/references/mainland-general.md"
  "$skill/references/wechat-miniprogram.md"
  "$skill/references/ios-android-app.md"
  "$skill/references/privacy-and-data.md"
  "$skill/references/payment-and-settlement.md"
  "$skill/references/property-fee-project.md"
  "$skill/assets/compliance-report-template.md"
)

for file in "${required_files[@]}"; do
  test -f "$file" || { echo "missing: $file" >&2; exit 1; }
done

grep -q '^name: china-app-launch-compliance$' "$skill/SKILL.md"
grep -q '^description: Use when' "$skill/SKILL.md"
grep -q '联网核验' "$skill/SKILL.md"
grep -q '必须\|条件触发\|建议\|待确认\|不适用' "$skill/SKILL.md"
grep -q '法律法规.*平台规则' "$skill/SKILL.md"

grep -q '来源优先级' "$skill/references/evidence-and-sources.md"
grep -q '核验日期' "$skill/references/evidence-and-sources.md"
grep -q '备案.*许可' "$skill/references/mainland-general.md"
grep -q 'APP备案' "$skill/references/mainland-general.md"
grep -q '小程序备案' "$skill/references/wechat-miniprogram.md"
grep -q '目标商店' "$skill/references/ios-android-app.md"
grep -q '第三方 SDK' "$skill/references/privacy-and-data.md"
grep -q '敏感个人信息' "$skill/references/privacy-and-data.md"
grep -q '商户主体' "$skill/references/payment-and-settlement.md"
grep -q '二清' "$skill/references/payment-and-settlement.md"
grep -q '物业服务合同\|授权' "$skill/references/property-fee-project.md"
grep -q '房屋.*绑定\|业主.*身份' "$skill/references/property-fee-project.md"

grep -q '合规矩阵' "$skill/assets/compliance-report-template.md"
grep -q '缺失事实' "$skill/assets/compliance-report-template.md"
grep -q '来源登记' "$skill/assets/compliance-report-template.md"
grep -q '不构成正式法律意见' "$skill/assets/compliance-report-template.md"

echo "china-app-launch-compliance structure: PASS"
