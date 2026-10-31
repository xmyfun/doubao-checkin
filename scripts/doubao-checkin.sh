#!/bin/bash
# 豆包每日领取 —— launchd 的唯一入口（也是你手动执行时用的脚本）
#
# 为什么需要这一层：plist 里的 node 路径一旦写死，node 升级/挪位置就永久失效，
# 而 launchd 的报错只会写进 .err，你不会收到任何提示。
# 这个 wrapper 每次运行时动态找 node，按优先级依次尝试。
#
# 用法：
#   ./scripts/doubao-checkin.sh [选项]            —— 选项见 ./scripts/doubao-checkin.sh --help
#   ./scripts/doubao-checkin.sh --which-node      # 只检查 node，不执行
#   ./scripts/doubao-checkin.sh --find-node       # 看运行时会用哪个 node、机器上还有哪些
#   ./scripts/doubao-checkin.sh --install-node    # 下载一份 node 到 vendor/
#
# 本脚本只负责「找到 node，然后把参数原样交给 bin/cli.mjs」。
# 参数语义、help、分发都在 bin/cli.mjs —— 只有一份，别在这里再加。
#
# --which-node 的退出码：0 = 可用 / 1 = 找不到 / 2 = 找到了但版本太低

set -uo pipefail

# 极简环境（env -i）下没有 HOME，这里兜一个，避免 set -u 直接炸
HOME="${HOME:-/Users/$(id -un)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 唯一的 node 入口。参数解析和 help 都在 bin/cli.mjs 里，这一层只管找 node。
ENTRY="$HERE/bin/cli.mjs"
CONF="$HERE/config.conf"

# 这一层只处理三个参数：--which-node / --find-node / --install-node。
# 它们的职责就是"在还没有 node 的时候找 node"，所以**永远**搬不到 node 程序里，
# 也就永远需要这一层自己的判断。其余参数一律透传给 bin/cli.mjs。
#
# --help 不在这里处理：help 只有一份，由 bin/cli.mjs 生成。
# 在这里手写一份的话，每次加参数都得记得改两处，迟早漏。

# 允许直接跑项目里的其他 .mjs（排障脚本用）：
#   ./scripts/doubao-checkin.sh 某个脚本.mjs
if [ "${1:-}" != "${1#*/}" ] && [ "${1##*.}" = "mjs" ] && [ -f "$1" ]; then
  ENTRY="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  shift
fi
REQUIRED_MAJOR=22

LAST_TOO_OLD=""

MARK_FILE="$HERE/.install-node-attempt"   # 自动下载失败的冷却标记
COOLDOWN=21600                            # 6 小时内失败过就不再重试

# 从 config.conf 读一项（格式：key = value，# 后面是注释）
# 读不到就输出空串，由调用方决定兜底
conf_get() {
  local key="$1"
  [ -f "$CONF" ] || return 0
  /usr/bin/awk -v k="$key" '
    { sub(/#.*/, "") }
    index($0, "=") > 0 {
      key = $0; sub(/=.*/, "", key); gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key == k) {
        val = $0; sub(/^[^=]*=/, "", val); gsub(/^[ \t]+|[ \t]+$/, "", val)
        print val; exit
      }
    }' "$CONF"
}

# 同一份 node 可能有好几条路径（`/usr/local/opt/node@24/bin/node` 是软链，
# 真身是 `Cellar/node@24/.../bin/node`；PATH 里也常有软链）。
# 用 inode+设备号认人，才能知道"这俩其实是同一个文件"。
# 拿不到就退回路径本身，行为等价于按路径去重。
file_key() {
  /usr/bin/stat -L -f '%d:%i' "$1" 2>/dev/null || printf '%s' "$1"
}

# ── App 自带的 node：**定点 glob，不递归** ──
#
# 为什么单独抽出来：运行时（candidates）和 --find-node 都要看这几个位置。
# 两处各写一份路径，改一处忘一处就会漂 —— 而且两边的过滤规则本来就不同。
#
# 为什么是 glob 而不是遍历：~/Library/Application Support 受 macOS TCC 保护，
# 递归遍历会弹「访问其他 App 数据」授权框。launchd 后台没人点 = 静默失败。
# 定点 glob 只 stat 已知路径，不弹框、毫秒级返回。
doubao_nodes() {
  local p
  for p in "$HOME"/Library/Application\ Support/Doubao/sandbox_runtime/bases/*/bin/node; do
    [ -x "$p" ] && printf '%s\n' "$p"
  done
}

# 其他 App 自带的 node（各 App 的 <App>/sandbox_runtime/bases/*/bin/node 与 <App>/node/bin/node）
#
# ⚠️ **只给 `--find-node` 用**，不在运行时的候选清单里：运行时要在这两类位置上
#    列 Application Support 的子目录（127 个条目，逐个解析），是整条查找最贵的部分，
#    而"别的 App 自带的 node"几乎不会是用户想用的那个。运行时只在 Application Support
#    里认豆包（定点 glob，见上），其他一律交给 PATH / 系统 / 版本管理器。
other_app_nodes() {
  local p
  for p in "$HOME"/Library/Application\ Support/*/sandbox_runtime/bases/*/bin/node \
           "$HOME"/Library/Application\ Support/*/node/bin/node; do
    [ -x "$p" ] && printf '%s\n' "$p"
  done
}

# 按优先级列出所有候选，格式：来源<TAB>路径（不判断存在性，交给 find_node）
#
# 带「来源」是为了让 --which-node / --find-node 能说清"命中的是哪一类位置"，
# 而不是只能看到一个绝对路径反推。
#
# 关键设计：完全不依赖 `command -v node`，也就是不依赖 PATH。
# 因为 launchd 不继承你 shell 的 PATH，而很多软件会把 node 装在自己的目录里。
#
# 顺序原则：**越"确定存在且受控"的越靠前**
#   0. config.conf 里用户亲手指定的      —— 用户说了算
#   1. vendor/node                       —— 我们下载的，一定可用
#   2. PATH                              —— 终端里用户当前选中的版本
#   3. 系统标准位置                       —— Homebrew 等
#   4. 版本管理器固定目录                  —— launchd 下 PATH 是空的，靠这层
#   5. 豆包自带                           —— ⚠️ 必须早于其他软件：装了豆包就一定有
#   6. 其他桌面软件自带                    —— 兜底
#
# ⚠️ 这里**没有**"Application Support 里其他 App"这一类：只有 --find-node 会列它们。
#    运行时不碰 —— 那个目录要逐项解析（最贵的一段），而别的 App 自带的 node
#    几乎不可能是用户想用的那个。要固定用某一份，填 nodePath，别指望自动发现。
candidates() {
  local configured p

  # 0. 配置文件指定（最高优先级）
  configured="$(conf_get nodePath)"
  if [ -n "$configured" ]; then
    case "$configured" in
      "~/"*) configured="$HOME/${configured#\~/}" ;;
    esac
    printf '配置 nodePath\t%s\n' "$configured"
  fi

  # 1. 项目自带（只有 install-node.sh 下载的那份会在这里）
  printf '项目 vendor/\t%s\n' "$HERE/vendor/node"

  # 2. 当前 PATH —— 有 PATH 信息时的快路径
  #    nvm / fnm / volta 的工作原理就是把选中的版本插到 PATH 最前面。
  #    PATH 里同一个目录重复出现很常见（多个 rc 文件各 prepend 一次），
  #    用 awk 保序去重，否则同一条候选会印好几遍。
  if [ -n "${PATH:-}" ]; then
    printf '%s\n' "$PATH" | tr ':' '\n' | awk '!seen[$0]++' | while IFS= read -r p; do
      [ -n "$p" ] || continue
      printf 'PATH\t%s/node\n' "${p%/}"
    done
  fi

  # 3. 系统标准安装位置
  for p in /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node /usr/bin/node; do
    printf '系统\t%s\n' "$p"
  done

  # 3b. Homebrew 的 keg-only 版本（node@20 / node@24 这类**不会** link 到 bin/）
  #
  #     只写 /usr/local/bin/node 是不够的：版本化 formula 默认 keg-only，
  #     装完 `node` 命令根本不在 PATH 里，真实入口是 /usr/local/opt/node@24/bin/node。
  #     所以「brew 明明装了 node，运行时却当没有」不是幻觉 —— 这两个目录必须看。
  #     排在已 link 的 bin/ 之后：用户主动 link 的那个才是他选的主版本。
  for p in /opt/homebrew/opt/node*/bin/node /usr/local/opt/node*/bin/node; do
    [ -e "$p" ] && printf 'Homebrew keg\t%s\n' "$p"
  done

  # 4. 版本管理器的固定目录 —— 没有 PATH 信息时的兜底
  for p in "$HOME"/.nvm/versions/node/*/bin/node \
           "$HOME"/.fnm/node-versions/*/installation/bin/node \
           "$HOME"/.nodenv/versions/*/bin/node \
           "$HOME"/.volta/bin/node \
           "$HOME"/.asdf/shims/node \
           "$HOME"/.local/bin/node; do
    [ -e "$p" ] && printf '版本管理器\t%s\n' "$p"
  done

  # 5. 豆包客户端自带
  #
  #    为什么排在其他软件之前：
  #      · 这个项目的**硬前提**就是装了豆包 —— 所以这份必然存在
  #      · 它跟着豆包一起发布、由豆包自己验证过，兼容性最有把握
  #    为什么用 glob 而不是固定路径：
  #      目录名含 hash（bases/<hash>/bin/node），随版本变化。
  #      通配之后 hash 变了下次运行自动跟上，不需要改任何东西。
  #      （也有些软件的路径形如 versions/<x>/bin/node，同样会变，
  #        所以"路径会变"不构成把它排到最后的理由。）
  while IFS= read -r p; do
    printf '豆包自带\t%s\n' "$p"
  done < <(doubao_nodes)

  # 6. 其他软件自带的运行时（没装豆包、或豆包那份不可用时的兜底）
  #
  #    ⚠️ 这里**故意不看** ~/Library/Application Support 里的其他 App：
  #    那个目录受 macOS 保护，每次列目录都要逐项解析（127 个条目），是整条查找里
  #    最贵的部分；而"别的 App 自带的 node"几乎不会是用户想用的那个。
  #    所以运行时只在 Application Support 里认豆包（定点 glob，见上），
  #    其他 App 的那几份只由 --find-node 列出来给人看（见 other_app_nodes 的调用处）。
  for p in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
           "$HOME"/.trae-cn/binaries/node/versions/*/bin/node \
           "$HOME"/.hermes/node/bin/node \
           "$HOME"/.claude/local/node; do
    [ -e "$p" ] && printf '其他软件\t%s\n' "$p"
  done
}

# 找到一个「真的能跑」且主版本 >= REQUIRED_MAJOR 的 node。
# 成功时输出一行：来源<TAB>绝对路径
#   —— 带上来源，调用方才能回答"用的哪一类位置"（是 PATH 还是豆包自带）。
#   用 TAB 而不是空格：路径里可能有空格，不能靠空格切。
#   也不能用全局变量传：函数几乎总在 $(...) 里调用，子 shell 改的变量传不回来。
find_node() {
  local src c v major
  while IFS=$'\t' read -r src c; do
    [ -n "$c" ] || continue
    [ -x "$c" ] || continue

    # 关键：真的执行一次。有些「node」是占位符、架构不匹配、或链接已断，
    # 光判断文件存在是不够的。
    v="$("$c" -v 2>/dev/null)" || continue
    [ -n "$v" ] || continue

    major="$(printf '%s' "$v" | sed 's/^v//' | cut -d. -f1)"
    case "$major" in
      ''|*[!0-9]*) continue ;;
    esac

    if [ "$major" -ge "$REQUIRED_MAJOR" ]; then
      printf '%s\t%s\n' "$src" "$c"
      return 0
    fi

    [ -n "$LAST_TOO_OLD" ] || LAST_TOO_OLD="$c ($v)"
  done < <(candidates)

  return 1
}

# ── 下载 node 到 vendor ──
if [ "${1:-}" = "--install-node" ]; then
  shift
  exec "$HERE/scripts/install-node.sh" "$@"
fi

# config.conf 里填的路径如果不可用，提示一句再继续按顺序找 —— 不让整件事挂掉
warn_bad_configured_node() {
  local c
  c="$(conf_get nodePath)"
  [ -n "$c" ] || return 0
  case "$c" in "~/"*) c="$HOME/${c#\~/}" ;; esac
  local v major
  if ! v="$("$c" -v 2>/dev/null)"; then
    echo "提示：config.conf 里的 nodePath 不可执行或不存在，已忽略并继续查找：$c" >&2
    return 0
  fi
  major="$(printf '%s' "$v" | sed 's/^v//' | cut -d. -f1)"
  if ! [ "$major" -ge "$REQUIRED_MAJOR" ] 2>/dev/null; then
    echo "提示：config.conf 里的 nodePath 版本太低（${v}），已忽略并继续查找" >&2
  fi
}

# 所有候选都没找到时，自动下载一份官方 node 到 vendor/
try_autofetch() {
  case "$(conf_get autoInstallNode)" in
    false|no|0|off) return 1 ;;
  esac
  [ -x "$HERE/scripts/install-node.sh" ] || return 1

  if [ -f "$MARK_FILE" ]; then
    local mtime age
    mtime="$(stat -f%m "$MARK_FILE" 2>/dev/null || echo 0)"
    age=$(( $(date +%s) - mtime ))
    # 刚失败过就别再试了，否则每小时兜底都要在下载上白等
    [ "$age" -lt "$COOLDOWN" ] && return 1
  fi

  echo "未找到可用的 node，自动下载一份到 vendor/ …" >&2
  if "$HERE/scripts/install-node.sh" -q >&2 2>&1; then
    rm -f "$MARK_FILE"
    [ -x "$HERE/vendor/node" ]
    return $?
  fi

  touch "$MARK_FILE"
  return 1
}

# ── 找 node：先说清「运行时用哪个」，再说「还能找到哪些」──
#
# 最容易误解的一点：如果只给一个「全盘扫出来的列表」，列表里没有豆包那份，
# 可运行时偏偏会用它 —— 看起来像两套逻辑。
# 实际上运行时用的是 candidates()（固定清单 + 定点 glob），**必然**和"全盘扫"
# 不一致（后者能扫到任意角落，前者只能是白名单）。差别不该藏起来，要摆出来：
#
#   A 段 = 运行时真的会走的顺序，直接复用 find_node()，所以结论不可能和签到不一致
#   B 段 = 全盘扫到的其他 node —— 不在固定清单里，运行时**永远不会**自动选它
#
# B 段为什么不能直接 find ~：
#   macOS 把 Desktop / Documents / Downloads / Music / Pictures / Movies /
#   iCloud Drive 归为「隐私数据」，遍历它们会弹系统授权框。Application Support
#   同理（「访问其他 App 数据」）。所以只扫白名单目录，Spotlight 结果也照样过滤。
#   想看 Application Support 更深的角落才加 --all（会弹授权框、很慢）。
if [ "${1:-}" = "--find-node" ]; then
  DEEP=0
  [ "${2:-}" = "--all" ] && DEEP=1

  printf '运行时（签到 / 定时任务）按这个顺序找 node，取第一个 v%s+ 可用的：\n\n' "$REQUIRED_MAJOR"

  HIT="$(find_node)" || HIT=""
  if [ -n "$HIT" ]; then
    PICKED="${HIT#*$'\t'}"
  else
    PICKED=""
  fi

  PATH_DIRS=0
  PATH_HITS=0
  if [ -n "${PATH:-}" ]; then
    PATH_DIRS="$(printf '%s\n' "$PATH" | tr ':' '\n' | awk 'NF && !seen[$0]++ {n++} END {print n+0}')"
  fi

  SEEN="|"
  while IFS=$'\t' read -r src p; do
    [ -n "$p" ] || continue
    # 同一个可执行文件可能被好几处引用（PATH 里的软链、opt/Cellar 两套路径、App 的 glob），
    # 只报一次，来源保留最先命中的那一类 —— 那才是运行时实际会走的路径。
    k="$(file_key "$p")"
    case "$SEEN" in *"|$k|"*) continue ;; esac
    [ -x "$p" ] || continue
    v="$("$p" -v 2>/dev/null)" || continue
    [ -n "$v" ] || continue
    major="$(printf '%s' "$v" | sed 's/^v//' | cut -d. -f1)"
    case "$major" in ''|*[!0-9]*) continue ;; esac

    [ "$src" = "PATH" ] && PATH_HITS=$((PATH_HITS + 1))
    if [ "$p" = "$PICKED" ]; then
      mark='✓'
      note='← 本次会用它'
    elif [ "$major" -ge "$REQUIRED_MAJOR" ]; then
      mark='·'
      note='排在后面（前面那个能用就不会看它）'
    else
      mark='✗'
      note="版本太低（需要 v${REQUIRED_MAJOR}+）"
    fi
    printf '  %s %s\n      %s · 来源 %s · %s\n\n' "$mark" "$p" "$v" "$src" "$note"
    SEEN="$SEEN$k|"
  done < <(candidates)

  if [ "$SEEN" = "|" ]; then
    printf '  （上面这些位置一个能跑的 node 都没有，得靠 --install-node 了）\n\n'
  fi

  CFG_NODE="$(conf_get nodePath)"
  if [ -n "$CFG_NODE" ]; then
    case "$CFG_NODE" in "~/"*) CFG_TMP="$HOME/${CFG_NODE#\~/}" ;; *) CFG_TMP="$CFG_NODE" ;; esac
    if [ -x "$CFG_TMP" ]; then
      printf 'config.conf 的 nodePath：%s（永远排第一）\n' "$CFG_NODE"
    else
      printf 'config.conf 的 nodePath：%s ⚠ 不可执行或不存在，本次已被跳过\n' "$CFG_NODE"
    fi
  else
    printf 'config.conf 的 nodePath：未设置（填了会排第一，优先于 PATH）\n'
  fi
  printf 'PATH：%s 个目录，命中 %s 个\n\n' "$PATH_DIRS" "$PATH_HITS"

  printf '这台机器上另外找到的 node（不在上面的查找范围里，运行时不会自动选它们；\n想固定用就填进 config.conf）：\n\n'
  if [ "$DEEP" = "1" ]; then
    printf '（--all：会递归遍历 ~/Library/Application Support，可能弹「访问其他 App 数据」授权框）\n\n'
  fi

  EXTRA=0
  while IFS=$'\t' read -r p src; do
    # 同一个文件（opt 软链 / Cellar 真身 / PATH 软链）上半段已经报过就不再重复
    case "$SEEN" in *"|$(file_key "$p")|"*) continue ;; esac
    [ -x "$p" ] || continue
    v="$("$p" -v 2>/dev/null)" || continue
    [ -n "$v" ] || continue
    printf '  %s\n      %s · 来源 %s\n\n' "$p" "$v" "$src"
    SEEN="$SEEN$(file_key "$p")|"
    EXTRA=$((EXTRA + 1))
  done < <(
    {
      # Spotlight 索引：快、覆盖面大，但**不索引家目录下的点目录**（~/.cache、~/.nvm 都不在里面）
      /usr/bin/mdfind -name node 2>/dev/null | grep -E '/bin/node$' \
        | while IFS= read -r p; do printf '%s\tSpotlight\n' "$p"; done
      # 兜底：对白名单目录真扫一遍。每个目录最多下探 6 层 —— 再往下基本都是
      # node_modules 这类无关目录，遍历成本随深度上升、收益接近零。
      #（实测：深度 6 够到 ~/.cache/<工具名>/.../node/bin/node 这类布局，再深就没了）
      for d in "$HOME/.nvm" "$HOME/.fnm" "$HOME/.nodenv" "$HOME/.volta" "$HOME/.asdf" \
               "$HOME/.workbuddy" "$HOME/.trae-cn" "$HOME/.hermes" "$HOME/.claude" \
               "$HOME/.codex" "$HOME/.local" "$HOME/.cache" \
               /opt /usr/local /usr/bin; do
        [ -d "$d" ] || continue
        /usr/bin/find "$d" -maxdepth 6 -type f -name node -perm -u+x 2>/dev/null \
          | while IFS= read -r p; do printf '%s\tfind %s\n' "$p" "${d/#$HOME/~}"; done
      done
      if [ "$DEEP" = "1" ]; then
        /usr/bin/find "$HOME/Library/Application Support" -maxdepth 6 \
          -type f -name node -perm -u+x 2>/dev/null \
          | while IFS= read -r p; do printf '%s\tfind ~/Library/Application Support\n' "$p"; done
      fi
    } \
      | grep -vE "^$HOME/(Desktop|Documents|Downloads|Music|Pictures|Movies)/" \
      | grep -v "^$HOME/Library/Mobile Documents" \
      | { if [ "$DEEP" = "1" ]; then cat; else grep -v "^$HOME/Library/Application Support/"; fi; } \
      | { cat
          # 运行时不再看 Application Support 里的其他 App（那里最贵，且几乎不会是用户想用的），
          # 但 --find-node 要把它们列出来：用定点 glob，不递归。
          while IFS= read -r p; do printf '%s\t定点 Application Support\n' "$p"; done < <(other_app_nodes)
        } \
      | sort -u | awk -F'\t' '!seen[$1]++' | head -60
  )

  if [ "$EXTRA" = "0" ]; then
    printf '  （没有扫到别的。想更彻底：加 --all）\n\n'
  fi

  printf '想固定用某一个？把它的路径填进 config.conf：\n\n'
  printf '  nodePath = /上面那个路径\n'
  exit 0
fi

# ── 只检查 node ──
if [ "${1:-}" = "--which-node" ]; then
  warn_bad_configured_node
  if HIT="$(find_node)"; then
    HIT_SRC="${HIT%%$'\t'*}"
    HIT_BIN="${HIT#*$'\t'}"
    printf 'path:    %s\n' "$HIT_BIN"
    printf 'version: %s\n' "$("$HIT_BIN" -v 2>/dev/null)"
    printf 'source:  %s\n' "$HIT_SRC"
    printf 'status:  ok (需要 v%s+)\n' "$REQUIRED_MAJOR"
    exit 0
  fi

  if [ -n "$LAST_TOO_OLD" ]; then
    printf 'path:    %s\n' "$LAST_TOO_OLD"
    printf 'status:  版本太低，需要 v%s 或更新\n' "$REQUIRED_MAJOR" >&2
    exit 2
  fi

  printf 'status:  未找到 node\n' >&2
  exit 1
fi

# ── 正常运行 ──
warn_bad_configured_node

if ! HIT="$(find_node)"; then
  # 只是想看帮助的话，不要为它自动下载 node（几十 MB，还可能很慢）。
  # 直接说清楚"帮助需要 node"，下一步怎么办。
  case " ${1:-} " in
    " --help "|" -h ")
      echo "帮助由 node 程序生成，这台机器上暂时找不到可用的 node（需要 v${REQUIRED_MAJOR}+）。" >&2
      echo "  先装 node：$HERE/scripts/install-node.sh" >&2
      echo "  装好之后再执行：./scripts/doubao-checkin.sh --help" >&2
      echo "  找不到 node 时能用的三个参数（由本脚本自己处理）：" >&2
      echo "    --which-node     检查 node 能不能找到" >&2
      echo "    --find-node      列出运行时按什么顺序找、实际会用哪个（加 --all 连深目录一起扫）" >&2
      echo "    --install-node   下载一份 node 到 vendor/" >&2
      exit 1
      ;;
  esac

  if try_autofetch; then
    NODE_BIN="$HERE/vendor/node"
    echo "已自动下载 node 到 ${NODE_BIN}（$("$NODE_BIN" -v 2>/dev/null)）" >&2
  else
    if [ -n "$LAST_TOO_OLD" ]; then
      echo "找到的 node 版本太低：${LAST_TOO_OLD}（需要 v${REQUIRED_MAJOR}+）" >&2
      /usr/bin/osascript -e "display alert \"豆包每日领取 无法运行\" message \"node 版本太低（${LAST_TOO_OLD}），需要 v${REQUIRED_MAJOR} 或更新。请升级 Node。\" as warning" >/dev/null 2>&1 &
    else
      echo "找不到可用的 node，自动下载也没成功" >&2
      echo "  手动试：$HERE/scripts/install-node.sh" >&2
      /usr/bin/osascript -e 'display alert "豆包每日领取 无法运行" message "找不到可用的 node，自动下载也失败了。请联网后运行 scripts/install-node.sh，或安装 Node 22+。" as warning' >/dev/null 2>&1 &
    fi
    echo "  弄好 node 之后，./scripts/doubao-checkin.sh --help 可以看全部参数" >&2
    exit 1
  fi
else
  NODE_BIN="${HIT#*$'\t'}"
fi

exec "$NODE_BIN" "$ENTRY" "$@"
