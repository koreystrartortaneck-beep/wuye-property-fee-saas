#!/bin/bash
# 上传小程序到微信平台。
#
# 上传 ≠ 提审：本脚本只把代码推成一个「开发版本」，之后要在微信公众平台
# 「版本管理 → 开发版本 → 提交审核」。
#
# 前置两项，都必须在开发者工具的 GUI 里做一次，CLI 无法代替：
#   1) 设置 → 安全设置 → 开启「服务端口」
#   2) 扫码登录
#
# 用法：bash upload-miniprogram.sh [版本号]
set -uo pipefail

CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
PROJ="$(cd "$(dirname "$0")" && pwd)/apps/miniprogram"
VER="${1:-1.1.0}"
DESC="时区修复（全站早8小时/访客日期早一天）、加载失败不再显示¥0.00、订阅消息模板ID、枚举文案与后台对齐、卡券金额精度、注销匿名化提示"

[ -x "$CLI" ] || { echo "✗ 找不到微信开发者工具 CLI：$CLI"; exit 1; }
[ -d "$PROJ" ] || { echo "✗ 找不到小程序目录：$PROJ"; exit 1; }

# islogin 在服务端口关闭时是**交互式**的（会提示 enter y to confirm），
# 直接调用会挂住等输入 —— 所以喂一个 EOF 并限时。
probe() { printf '' | timeout 30 "$CLI" islogin 2>&1 || true; }
OUT="$(probe)"

if grep -q "服务端口\|service port disabled" <<<"$OUT"; then
  cat <<'TIP'
✗ 开发者工具的「服务端口」未开启，CLI 无法调用工具。
  打开微信开发者工具 → 右上角「设置」→「安全设置」→ 把「服务端口」打开，
  然后重跑本脚本。
TIP
  exit 1
fi

if ! grep -qiE "true|已登录|logged in" <<<"$OUT"; then
  echo "✗ 开发者工具未登录（或未启动）。请打开工具扫码登录后重跑。"
  echo "  islogin 输出："
  grep -vE "Deprecation|punycode|trace-deprecation" <<<"$OUT" | sed 's/^/    /' | tail -4
  exit 1
fi

mkdir -p "$(dirname "$0")/outputs"
echo "→ 上传 $PROJ  版本 $VER"
"$CLI" upload \
  --project "$PROJ" \
  --version "$VER" \
  --desc "$DESC" \
  --info-output "$(dirname "$0")/outputs/upload-result.json"

echo "✓ 上传完成，版本 $VER"
echo "  下一步：微信公众平台 → 版本管理 → 开发版本 → 提交审核"
