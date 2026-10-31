#!/bin/bash
# 下载官方 Node 二进制到项目的 vendor/node。
#
# 用途：机器上一份可用的 node 都没有时（系统没 node，也没装自带运行时的其他软件），
#       用它一次性备好，之后不依赖任何系统环境。
#
# 用法：
#   ./scripts/install-node.sh           # 下载并放到 vendor/node
#   ./scripts/install-node.sh --check   # 只确认下载地址，不真的下
#   NODE_MAJOR=24 ./scripts/install-node.sh
#   NODE_MIRROR=https://npmmirror.com/mirrors/node ./scripts/install-node.sh   # 国内镜像
#
# 只取 tarball 里的 bin/node 一个文件（约 100MB），不装 npm，够用即可。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/vendor"
MAJOR="${NODE_MAJOR:-22}"
MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"

CHECK_ONLY=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -q|--quiet) QUIET=1 ;;
  esac
done

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
cyan() { [ "$QUIET" = "1" ] && return 0; printf '\033[36m%s\033[0m\n' "$*"; }

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) red "不支持的 CPU 架构：$ARCH"; exit 1 ;;
esac

command -v curl >/dev/null || { red "缺少 curl"; exit 1; }
command -v tar >/dev/null || { red "缺少 tar"; exit 1; }

INDEX="$MIRROR/latest-v${MAJOR}.x/"
cyan "查询最新 v${MAJOR}（darwin-${NODE_ARCH}）…"

TARBALL="$(curl -fsSL --max-time 30 "$INDEX" 2>/dev/null \
  | grep -oE "node-v${MAJOR}\.[0-9]+\.[0-9]+-darwin-${NODE_ARCH}\.tar\.gz" \
  | head -1 || true)"

if [ -z "$TARBALL" ]; then
  red "在 $INDEX 没找到 darwin-${NODE_ARCH} 的包"
  echo "  可能原因：网络不通 / 镜像地址不对 / 该大版本已停止发布"
  echo "  手动下载：https://nodejs.org/dist/latest-v${MAJOR}.x/"
  exit 1
fi

URL="$INDEX$TARBALL"
cyan "包      $TARBALL"
cyan "地址    $URL"

if [ "$CHECK_ONLY" = "1" ]; then
  green "（--check）不下载，仅确认地址可用"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cyan "下载中（约 45MB）…"
CURL_FLAGS="-fL"
[ "$QUIET" = "1" ] || CURL_FLAGS="-fL --progress-bar"
if ! curl $CURL_FLAGS "$URL" -o "$TMP/node.tar.gz"; then
  red "下载失败"
  echo "  国内网络可试镜像："
  echo "  NODE_MIRROR=https://npmmirror.com/mirrors/node ./scripts/install-node.sh"
  exit 1
fi

cyan "解压…"
tar xzf "$TMP/node.tar.gz" -C "$TMP"

SRC="$(ls -d "$TMP"/node-v*/bin/node 2>/dev/null | head -1)"
[ -n "$SRC" ] || { red "解压后找不到 bin/node"; exit 1; }

mkdir -p "$VENDOR"
cp "$SRC" "$VENDOR/node"
chmod +x "$VENDOR/node"

VERSION="$("$VENDOR/node" -v 2>/dev/null || echo '?')"
green "完成：$VENDOR/node  $VERSION"
echo
echo "vendor/node 只排在 config.conf 的 nodePath 之后，定时任务用绝对路径调用，不受环境变量影响。"
echo "验证一下："
echo "  ./scripts/doubao-checkin.sh --which-node"
