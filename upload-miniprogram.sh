#!/bin/bash
# 上传小程序到微信平台。
#
# 上传 ≠ 提审：本脚本只把代码推成一个「开发版本」，之后要在微信公众平台
# 「版本管理 → 开发版本 → 提交审核」。
#
# 前置两项：
#   1) 服务端口。**在你自己的终端里跑本脚本时，工具会提示
#      「enter y to confirm enabling CLI capability」，直接输 y 即可开启** ——
#      不必去 GUI 翻设置。（我在非交互环境里跑不通这一步，因为它要求真实 TTY。）
#      也可手动开：工具 → 设置 → 安全设置 → 服务端口。
#   2) 扫码登录。这一步只能用手机扫，无法自动化。
#
# 用法：bash upload-miniprogram.sh [版本号]
#   注意要在**交互式终端**里跑，否则上面第 1 步的 y 确认无法输入。
set -uo pipefail

CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
PROJ="$(cd "$(dirname "$0")" && pwd)/apps/miniprogram"
VER="${1:-1.1.0}"
DESC="时区修复（全站早8小时/访客日期早一天）、加载失败不再显示¥0.00、订阅消息模板ID、枚举文案与后台对齐、卡券金额精度、注销匿名化提示"

[ -x "$CLI" ] || { echo "✗ 找不到微信开发者工具 CLI：$CLI"; exit 1; }
[ -d "$PROJ" ] || { echo "✗ 找不到小程序目录：$PROJ"; exit 1; }

# islogin 在服务端口关闭时是**交互式**的（会提示 enter y to confirm），
# 直接调用会挂住等输入 —— 所以喂一个 EOF 并限时。
# 交互式跑时不要吞掉 stdin —— 服务端口未开时工具会提示输 y 确认，那正是开启它的方式。
# 非交互（无 TTY）时喂 EOF 并限时，避免挂死。
if [ -t 0 ]; then
  OUT="$(timeout 180 "$CLI" islogin 2>&1 || true)"
else
  OUT="$(printf '' | timeout 30 "$CLI" islogin 2>&1 || true)"
fi

if grep -q "服务端口\|service port disabled" <<<"$OUT"; then
  if [ -t 0 ]; then
    cat <<'TIP'
✗ 服务端口未开启。刚才工具应该提示过 "enter y to confirm enabling CLI capability"，
  输 y 确认即可开启；若没看到提示，去 工具 → 设置 → 安全设置 → 打开「服务端口」。
  然后重跑本脚本。
TIP
  else
    cat <<'TIP'
✗ 服务端口未开启，且当前不是交互式终端（无法输入 y 确认）。
  请在你自己的终端里重跑本脚本，看到 "enter y to confirm" 时输 y；
  或手动开：工具 → 设置 → 安全设置 → 服务端口。
TIP
  fi
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
