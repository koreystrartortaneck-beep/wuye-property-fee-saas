#!/bin/bash
# 小程序真机验证 / 上传。
#
# 两种模式：
#
#   bash upload-miniprogram.sh --preview     ← 先用这个
#       终端里直接出二维码，用你自己的微信扫一下，代码立刻在手机上跑。
#       **不上传、不提审、不用等审核。** 连的是同一个生产后端，
#       真实微信支付也能走通，所以测出来的结果和正式版一样。
#       改一行代码就能重扫一次，这是验证功能的正确循环。
#
#   bash upload-miniprogram.sh [版本号]      ← 验证没问题之后再用这个
#       把代码推成一个「开发版本」。上传 ≠ 提审，之后要去微信公众平台
#       「版本管理 → 开发版本 → 提交审核」。
#       （也可以在公众平台把它设为「体验版」+ 加体验成员，
#         让物业的人也能试，同样不需要审核。）
#
# 前置两项：
#   1) 服务端口。**在你自己的终端里跑本脚本时，工具会提示
#      「enter y to confirm enabling CLI capability」，直接输 y 即可开启** ——
#      不必去 GUI 翻设置。（我在非交互环境里跑不通这一步，因为它要求真实 TTY。）
#      也可手动开：工具 → 设置 → 安全设置 → 服务端口。
#   2) 扫码登录。这一步只能用手机扫，无法自动化。

# ── 上传前语法预检 ──
# 这些错误平时只有开发者工具会报，而开发者工具要扫码才能开 ——
# 等能上传时才发现语法错，白扫一次码。预检不通过就别进扫码流程。
if command -v node >/dev/null 2>&1; then
  # 先刷新代码指纹，再预检 —— 顺序不能反：
  # 指纹是源码内容的哈希，写完它 apps/miniprogram 就变了，
  # 必须让预检看到最终要上传的那份代码。
  node "$(dirname "$0")/tools/stamp-miniprogram.mjs"
  if ! node "$(dirname "$0")/tools/miniprogram-preflight.mjs"; then
    echo "✗ 预检未通过，已中止（先修上面列出的问题再上传）"
    exit 1
  fi
else
  echo "（未找到 node，跳过语法预检）"
fi

#
#   注意要在**交互式终端**里跑，否则上面第 1 步的 y 确认无法输入。
set -uo pipefail

MODE=upload
if [ "${1:-}" = "--preview" ] || [ "${1:-}" = "-p" ]; then
  MODE=preview
  shift
fi

CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
PROJ="$(cd "$(dirname "$0")" && pwd)/apps/miniprogram"
VER="${1:-1.2.0}"
DESC="支付成功立刻反馈（不再卡在「确认支付结果」）、新增「入账中」状态并阻止重复支付、请求超时 12 秒、查单窗口延长至 20 秒"

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

if [ "$MODE" = preview ]; then
  echo "→ 生成预览二维码（不上传、不提审）"
  # 终端二维码：不落磁盘、不用切窗口，扫完即跑
  "$CLI" preview \
    --project "$PROJ" \
    --qr-format terminal \
    --info-output "$(dirname "$0")/outputs/preview-result.json"
  cat <<'NEXT'

✓ 用微信扫上面的二维码，代码立刻在手机上跑（开发版）。
  连的是生产后端，真实支付可用 —— 请用 ¥1 的「占位费用」账单测，别拿大额的试。

  验证清单见 docs/真机验证清单.md
  验证通过后再执行：bash upload-miniprogram.sh
NEXT
  exit 0
fi

echo "→ 上传 $PROJ  版本 $VER"
"$CLI" upload \
  --project "$PROJ" \
  --version "$VER" \
  --desc "$DESC" \
  --info-output "$(dirname "$0")/outputs/upload-result.json"

echo "✓ 上传完成，版本 $VER"
echo "  下一步：微信公众平台 → 版本管理 → 开发版本 → 提交审核"
echo "  （想让物业的人也先试用：同一页把它设为「体验版」并添加体验成员，无需审核）"
