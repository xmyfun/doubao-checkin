#!/bin/bash
# 注册 / 卸载 macOS launchd 定时任务
#
#   ./scripts/install-launchd.sh                       # 安装；装前问一次 allowRelaunch（Y/N 回车确认）
#   ./scripts/install-launchd.sh --allow-relaunch=yes   # 直接允许重启，写进 config.conf，不问
#   ./scripts/install-launchd.sh --allow-relaunch=no    # 直接不允许重启，写进 config.conf，不问
#   ./scripts/install-launchd.sh --allow-relaunch yes    # 同上，空格写法
#   ./scripts/install-launchd.sh --allow-relaunch no
#   ./scripts/install-launchd.sh --allow-relaunch        # 不带值 = yes
#   ./scripts/install-launchd.sh --dry-run             # 只打印将生成的 plist，不注册、不询问、不改配置
#   ./scripts/install-launchd.sh --test-webhook=<地址>  # 装完用这个地址发一条 webhook 测试消息（非交互传值）
#   ./scripts/install-launchd.sh --status              # 查看状态
#   ./scripts/install-launchd.sh --uninstall           # 卸载
#
# 交互式安装（终端里直接跑）若发现 config.conf 没填 notify.feishuWebhook，
# 会再问一次飞书群机器人地址：贴入即写进 config.conf，直接回车跳过。
# --dry-run 和 --test-webhook=<地址> 都不问。
#
# 两件必须知道的事：
#
#   1. 装完会**立刻运行一次**，不是等明天 —— 除非 config.conf 里
#      schedule.runAtLoad = false。
#      plist 里有 RunAtLoad，定义就是「任务被加载时执行一次」
#      （man launchd.plist：launched once at the time the job is loaded）。
#      所以这条安装命令一结束，签到脚本已经真的跑过了，不需要再 kickstart。
#
#   2. 签到必须以**调试模式**打开客户端，所以那一次运行会不会重启你正在用的豆包，
#      取决于 allowRelaunch：
#        客户端没启动        → 不需要它，直接带调试端口拉起，不打扰任何人
#        客户端带 CDP 在跑    → 直接复用，也不需要
#        客户端普通模式在跑    → 只有这种情况才需要它，否则本次跳过
#
#      allowRelaunch 是一个**长期生效的配置项**，住在 config.conf 里，不是 plist。
#      ★ 本脚本的 --allow-relaunch 只是替用户改 config.conf，**绝不写进 plist**：
#        写进 plist 会永久盖住配置文件，用户以后改 config.conf 就不生效了。
#      ★ 不带这个参数时，脚本会在 bootstrap 之前问一次 Y/N，并把选择写进 config.conf。
#
# 设计要点：
#   1. 调 scripts/doubao-checkin.sh 而不是直接调 node —— node 路径变了不会断
#   2. 触发时间来自 config.conf 的 schedule.times（默认 03:33 / 13:33）：
#      凌晨那一档重启客户端几乎无感，下午那一档兜底
#   3. 登录补跑（schedule.runAtLoad）与固定间隔兜底（schedule.intervalSeconds）
#      同样由 config.conf 控制，不写死在 plist 里

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# launchd 的 Label 用反向 DNS，和 bundle identifier 同一套逻辑：全局唯一、不撞车。
#
# ⚠️ 前缀必须是**自己拥有或能认领**的域名。不能用 `com.doubao.*` —— 那是字节跳动的
# 命名空间，会被 `launchctl list` 误认成官方组件；万一豆包自己做了签到 agent 用了同名
# label，两个只能活一个，先装的会被顶掉。
# 反向 DNS 标识的是"来源组织"（xmyfun.com），不是维护者个人。
LABEL="com.xmyfun.doubao-checkin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUN_SH="$PROJECT_DIR/scripts/doubao-checkin.sh"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

# ── 路径校验与日志目录 ──
# launchd 不解析 ~，也不接受相对路径。这里统一校验，写进 plist 的必须是绝对路径。

case "$PROJECT_DIR" in
  /*) ;;
  *) red "项目路径不是绝对路径：$PROJECT_DIR"; exit 1 ;;
esac

# 日志目录：优先读 config.conf 的 logDir，没填就用项目内 logs/
conf_get() {
  local key="$1"
  [ -f "$PROJECT_DIR/config.conf" ] || return 0
  /usr/bin/awk -v k="$key" '
    { sub(/#.*/, "") }
    index($0, "=") > 0 {
      key = $0; sub(/=.*/, "", key); gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key == k) {
        val = $0; sub(/^[^=]*=/, "", val); gsub(/^[ \t]+|[ \t]+$/, "", val)
        print val; exit
      }
    }' "$PROJECT_DIR/config.conf"
}

# 就地改 config.conf 里某一项。
#
# 为什么要有它：`--allow-relaunch` 要改的是**长期配置**（config.conf），不是 plist。
# 故意做得笨一点，只处理这一个场景：
#   · 找到 `key = ...` 那行，只换值，保留行首缩进和行尾注释
#   · 找不到就追加到文件末尾
#   · 改完比对行数，变少就放弃（防止 awk 意外吃掉内容）
# 结果放在 conf_set_changed：1 = 真的改了 / 0 = 内容本来就一样
conf_set() {
  local key="$1" val="$2" file="$PROJECT_DIR/config.conf" tmp before after
  conf_set_changed=0

  if [ ! -f "$file" ]; then
    printf '%s = %s\n' "$key" "$val" > "$file"
    conf_set_changed=1
    return 0
  fi

  tmp="$(mktemp -t doubao-conf)"
  /usr/bin/awk -v K="$key" -v V="$val" '
    BEGIN { done = 0 }
    done == 0 {
      bare = $0
      sub(/#.*/, "", bare)
      if (index(bare, "=") > 0) {
        name = bare
        sub(/=.*/, "", name)
        gsub(/^[ \t]+|[ \t]+$/, "", name)
        if (name == K) {
          eq = index($0, "=")
          tail = substr($0, eq + 1)
          cpos = index(tail, "#")
          note = ""
          if (cpos > 0) note = substr(tail, cpos)
          line = substr($0, 1, eq) " " V
          if (note != "") line = line "    " note
          print line
          done = 1
          next
        }
      }
    }
    { print }
    END { if (done == 0) printf "%s = %s\n", K, V }
  ' "$file" > "$tmp"

  before="$(wc -l < "$file" | tr -d ' ')"
  after="$(wc -l < "$tmp" | tr -d ' ')"
  if [ "$after" -lt "$before" ]; then
    red "改写 config.conf 时行数变少了（${before} → ${after}），已放弃，文件保持原样"
    rm -f "$tmp"
    return 1
  fi

  if cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    return 0
  fi

  mv "$tmp" "$file"
  conf_set_changed=1
  return 0
}

LOG_DIR="$(conf_get logDir)"
if [ -n "$LOG_DIR" ]; then
  case "$LOG_DIR" in
    "~"*)
      red "config.conf 的 logDir 不能用 ~ 开头：$LOG_DIR"
      red "  launchd 不解析 ~，请写完整路径，例如：$HOME/logs/doubao"
      exit 1
      ;;
    /*) ;;
    *)
      red "config.conf 的 logDir 必须是绝对路径：$LOG_DIR"
      exit 1
      ;;
  esac
else
  # 默认项目内 logs/；项目若在 TCC 保护区则回退
  case "$PROJECT_DIR" in
    "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
      LOG_DIR="$HOME/Library/Logs/doubao-checkin" ;;
    *)
      LOG_DIR="$PROJECT_DIR/logs" ;;
  esac
fi

# 定时时间**不写死在这里**：从 config.conf 的 schedule.times 读。
# 解析放在参数解析之后（见下面的「定时时间」段），因为 --uninstall / --status
# 不该被一个写错的 schedule.times 挡住 —— 卸载必须永远能跑。

# ── 参数（可组合）──
#   --dry-run                  只打印将要生成的 plist：不注册、不询问、不改 config.conf
#   --uninstall                卸载
#   --status                   查看状态
#   --run-now                  装完立刻触发一次（等价于手工 launchctl kickstart）
#   --allow-relaunch=yes|no    不询问，直接把这个值写进 config.conf 的 allowRelaunch
#   --allow-relaunch yes|no    同上，空格写法
#   --allow-relaunch           不带值 = yes
#   --test-webhook=<地址>      装完自检：**用这个地址**发一条测试消息，只用于这一条，
#                              不改 config.conf；空格写法 --test-webhook <地址> 也认
#   --test-webhook <地址>      同上
#
# 关于 --test-webhook 的值：它是给非交互安装用的 —— 自动化脚本不必先编辑
# config.conf，把地址直接写在命令行就能验通道。不带这个参数时，向导仍按
# config.conf 的 notify.feishuWebhook 自动发；两边都没配就静默跳过。
# ⚠ 定时任务本身永远只从 config.conf 读地址，参数里的地址不会被写进去。
#
# 交互式安装且 config.conf 没填地址时，会在 bootstrap 之前多问一句：贴入地址
# 就写进 config.conf（并用于本次自检），直接回车跳过。这样不必先手工编辑配置
# 文件也能把长期通知配好；已配置过的用户不会被反复打扰。
#
# 关于 --allow-relaunch 的语义（容易误会，写清楚）：
#   · 它**只改 config.conf，绝不写进 plist** —— 写进 plist 会永久盖住配置文件，
#     用户以后想通过 config.conf 改这个行为就不生效了
#   · yes → allowRelaunch = true（允许以调试模式重启正在运行的客户端）
#     no  → allowRelaunch = false（不允许重启；客户端普通模式开着时跳过本次）
#   · 不带它时，脚本会在 bootstrap 之前问一次，并把选择写进 config.conf
DRY=0
RUN_NOW=0
RELAUNCH_ARG=""      # 空 = 没指定 → 需要询问
RELAUNCH_ARG_SRC=""  # 记录用户是怎么给的，只用于输出
WEBHOOK_URL_ARG=""   # --test-webhook 的值；空 = 自检时按 config.conf 自动取地址
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY=1; shift ;;
    --run-now)  RUN_NOW=1; shift ;;
    --allow-relaunch=*)
      RELAUNCH_ARG="${1#*=}"
      RELAUNCH_ARG_SRC="--allow-relaunch=${1#*=}"
      # `--allow-relaunch=` 后面什么都没写：报错，不要静默退化成"去问用户"
      if [ -z "$RELAUNCH_ARG" ]; then
        red "--allow-relaunch= 后面要跟 yes 或 no（例：--allow-relaunch=yes）"
        exit 1
      fi
      shift
      ;;
    --allow-relaunch)
      # 支持三段写法：--allow-relaunch yes / --allow-relaunch no；裸写按 yes 处理
      shift
      RELAUNCH_ARG="yes"
      RELAUNCH_ARG_SRC="--allow-relaunch"
      case "$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')" in
        yes|no|y|n|true|false|1|0|on|off)
          RELAUNCH_ARG="$1"; RELAUNCH_ARG_SRC="--allow-relaunch $1"; shift ;;
      esac
      ;;
    --test-webhook=*)
      WEBHOOK_URL_ARG="${1#*=}"
      # 和 --allow-relaunch= 一致：空值直接报错，不静默退化成「去读 config.conf」
      if [ -z "$WEBHOOK_URL_ARG" ]; then
        red "--test-webhook= 后面要跟一个完整的 webhook 地址"
        exit 1
      fi
      shift
      ;;
    --test-webhook)
      # 空格写法。值必须是一个地址，不猜、不把下一个参数误当成值
      shift
      if [ $# -eq 0 ] || [[ "${1:-}" == --* ]]; then
        red "--test-webhook 后面要跟一个完整的 webhook 地址"
        red "  例：--test-webhook=https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
        exit 1
      fi
      WEBHOOK_URL_ARG="$1"
      shift
      ;;
    --uninstall)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"
      green "已卸载 $LABEL"
      exit 0
      ;;
    --status)
      if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|program|last exit code|runs" | head -8
      else
        echo "未安装"
      fi
      exit 0
      ;;
    *)
      red "未知参数：$1"
      echo "  可用：--dry-run  --run-now  --allow-relaunch=yes|no  --test-webhook=<地址>  --uninstall  --status"
      exit 1
      ;;
  esac
done

# 归一化：只认 yes / no（含常见的等价写法）
case "$(printf '%s' "$RELAUNCH_ARG" | tr 'A-Z' 'a-z' | tr -d ' ')" in
  '')                RELAUNCH_WANT="" ;;
  yes|y|true|1|on)   RELAUNCH_WANT="true" ;;
  no|n|false|0|off)  RELAUNCH_WANT="false" ;;
  *)
    red "--allow-relaunch 的值只能是 yes 或 no（收到：${RELAUNCH_ARG}）"
    exit 1
    ;;
esac

# 进入 plist 的参数序列

[ -f "$RUN_SH" ] || { red "找不到 scripts/doubao-checkin.sh"; exit 1; }
chmod +x "$RUN_SH" 2>/dev/null || true
[ -x "$RUN_SH" ] || { red "scripts/doubao-checkin.sh 不可执行"; exit 1; }

# macOS TCC 会拦截后台进程读取 ~/Documents、~/Desktop、~/Downloads
case "$PROJECT_DIR" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
    red "⚠ 项目在 TCC 保护目录下：$PROJECT_DIR"
    red "  launchd 后台进程读取会被拒绝（Operation not permitted），错误只进 .err 文件。"
    red "  请把项目移到 ~/Library/Application Support/ 或任意普通目录后重试。"
    exit 1
    ;;
esac

# ── 前置检查：用和 launchd 相同的极简环境验证 node ──
# 这不是"在 launchd 里跑"，而是**模拟它的环境变量**再跑一次 --which-node：
# 清空所有环境变量（env -i），PATH 只留 launchd 默认的四个系统目录。
# 关键点：终端里 `node -v` 能跑，不代表定时任务能找到它。
# launchd 不继承你 shell 的 PATH，nvm / 自定义路径 / 别名全都会丢。
NODE_INFO="$(env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUN_SH" --which-node 2>&1)" && NODE_RC=0 || NODE_RC=$?

if [ "$NODE_RC" -ne 0 ]; then
  red "在 launchd 的环境里找不到可用的 node："
  printf '%s\n' "$NODE_INFO" | sed 's/^/    /'
  echo
  red "注意：终端里 node -v 能跑，不等于定时任务能找到它。"
  red "      launchd 不继承你 shell 的 PATH（nvm、自定义路径、别名都会丢）。"
  echo "  解决办法（任选其一）："
  echo "    1) brew install node"
  echo "    2) mkdir -p \"$PROJECT_DIR/vendor\" && cp \"\$(command -v node)\" \"$PROJECT_DIR/vendor/node\""
  exit 1
fi
# 成功时报版本 + 路径：路径是用户唯一能确认"到底用了哪份 node"的凭据
NODE_VER="$(printf '%s\n' "$NODE_INFO" | /usr/bin/awk -F' *: *' '/^version:/{print $2; exit}')"
NODE_BIN="$(printf '%s\n' "$NODE_INFO" | /usr/bin/awk -F' *: *' '/^path:/{print $2; exit}')"
# 上面把 stdout 和 stderr 合并了（失败时状态行也是 stderr），所以这里要挑出真正的警告：
# 例如 config.conf 里的 nodePath 填错了，--which-node 会提示"已忽略"，那条必须让用户看见，
# 否则他填的值为什么不生效会一直是个谜。
NODE_NOTE="$(printf '%s\n' "$NODE_INFO" | /usr/bin/awk '!/^(path|version|source|status):/ && NF')"
if [ -n "$NODE_NOTE" ]; then
  yellow "$NODE_NOTE"
fi
green "✓ node ${NODE_VER} · ${NODE_BIN}  （launchd 环境下可用）"
echo

# ── 装完立刻会跑一次，所以先问清 allowRelaunch ──
#
# 为什么要在 bootstrap 之前问：RunAtLoad 的定义就是「任务被加载时执行一次」，
# 用户通常以为"装完要等明天才生效"，事实正好相反 —— 安装这一刻才是最可能打扰人的时刻。
#
# 判断依据只有 config.conf 一项（plist 里不写死，见文件头说明）。
# 解析规则与 src/settings.mjs 的 coerce() 保持一致：true/yes/1/on 为真，
# false/no/0/off 为假，没写或不认识则用默认值 true。
# RELAUNCH_RAW_VALID 记录"文件里的值能不能看懂"，看不懂时后面会强制重写一遍。

RELAUNCH_RAW="$(conf_get allowRelaunch)"
RELAUNCH_RAW_VALID=1
case "$(printf '%s' "$RELAUNCH_RAW" | tr 'A-Z' 'a-z')" in
  false|no|0|off)   RELAUNCH=false ;;
  true|yes|1|on)    RELAUNCH=true ;;
  '')               RELAUNCH=true ;;
  *)                RELAUNCH=true; RELAUNCH_RAW_VALID=0 ;;
esac

if [ "${DRY:-0}" = "1" ]; then
  echo "# --dry-run：只打印将生成的 plist，不注册、不询问、不改 config.conf"
else
  yellow "⚠ 安装完成会立刻运行一次尝试签到！"
fi
echo "自动签到脚本需要以【调试模式】启动豆包客户端才能自动进行签到。"
echo "定时任务执行时，如豆包客户端【已启动】，将依据配置项 allowRelaunch（当前值为 ${RELAUNCH}）决定是否重启。"

# ── 决定 allowRelaunch：写进 config.conf，不写 plist ──
#
# 三种入口：
#   --allow-relaunch=yes|no  直接写，不问
#   --dry-run                不问、不写，只说明
#   都没有                    交互提问，把选择写进 config.conf
#
# 这一步必须在 bootstrap **之前**：plist 一加载就会立刻跑一次，那时 allowRelaunch 已经定下来了。

APPLY=""
APPLY_HOW=""
if [ -n "$RELAUNCH_WANT" ]; then
  APPLY="$RELAUNCH_WANT"
  APPLY_HOW="按参数 ${RELAUNCH_ARG_SRC}"
elif [ "${DRY:-0}" = "1" ]; then
  :   # --dry-run 的开头已经说明过，这里不再重复
else
  # 三个选项的说明与用户给定的文案一致；「当前值」必须动态取自 config.conf
  echo "您此时可对 allowRelaunch 进行配置："
  echo "- Y(es) = true，允许重启豆包客户端到调试模式，签到后再次重启豆包客户端到普通模式。"
  echo "- N(o) = false，不允许重启豆包客户端进行签到，将会跳过本次任务，等待下次执行。"
  echo "- 回车   = 保持当前（${RELAUNCH}），后续可在 config.conf 中更改。"
  # 读一整行（要按回车确认）。取值不区分大小写，下面是三种写法都认：
  #   y / yes / true   → true
  #   n / no  / false  → false
  #   直接回车          → 保持当前值
  # 其余输入一律提示后重问，不猜、不替用户做决定。
  while :; do
    printf '请按键选择：Y/N/回车？'
    ANS=""
    if read -r ANS; then
      case "$(printf '%s' "$ANS" | tr 'A-Z' 'a-z' | tr -d ' ')" in
        y|yes|true)  APPLY=true;  APPLY_HOW="你选了 Y"; break ;;
        n|no|false)  APPLY=false; APPLY_HOW="你选了 N"; break ;;
        '')          APPLY="$RELAUNCH"; APPLY_HOW="直接回车，保持当前值"; break ;;
        *)           red "只能输入 Y / N（也可写 yes/no、true/false），或直接回车（收到：${ANS}）" ;;
      esac
    else
      # 没有可读输入（非交互运行）：不动配置，沿用当前值，绝不替用户做决定
      echo
      APPLY="$RELAUNCH"
      APPLY_HOW="读不到输入，沿用当前值"
      yellow "（读不到输入，沿用当前 allowRelaunch = ${RELAUNCH}；想明确指定请加 --allow-relaunch=yes|no）"
      break
    fi
  done
fi

if [ -n "$APPLY" ] && [ "${DRY:-0}" != "1" ]; then
  if [ "$APPLY" = "$RELAUNCH" ] && [ "$RELAUNCH_RAW_VALID" = "1" ]; then
    green "✓ allowRelaunch = ${APPLY}（${APPLY_HOW}，config.conf 未改动）"
  elif conf_set allowRelaunch "$APPLY"; then
    green "✓ allowRelaunch = ${APPLY}（${APPLY_HOW}，已写入 config.conf）"
    RELAUNCH="$APPLY"
  else
    red "✗ 没能改 config.conf，安装继续，本次仍按 allowRelaunch = ${RELAUNCH} 运行"
  fi
fi
echo

# ── 飞书 webhook：交互式安装顺带把地址配好 ──
#
# 只在「config.conf 没填地址 + 没给 --test-webhook + 不是 --dry-run + 读得到 stdin」
# 时问一次。已配好的用户不该被反复打扰；非交互安装（管道、< /dev/null、自动化）
# 更不能卡在等待输入上 —— read 读不到就跳过，和上面 allowRelaunch 同一套规矩。
#
# 写回必须用 conf_set：它只替换 `key = ...` 那一行，保留行尾注释和其余配置。
# 为什么不像 --test-webhook 那样只发一条消息了事：定时任务永远从 config.conf 读
# 地址，参数里的值不会进 plist；不写进去就是「这次测得通、以后一条都收不到」。
#
# 这一段被 test/install-launchd.test.mjs 按函数名抽取执行，函数体内不要写
# 依赖后面才定义的变量。
prompt_webhook() {
  if [ "${DRY:-0}" = "1" ]; then return 0; fi
  if [ -n "${WEBHOOK_URL_ARG:-}" ]; then return 0; fi
  if [ -n "$(conf_get notify.feishuWebhook)" ]; then return 0; fi

  echo "飞书群通知（可选）：签到成功、熔断停工会推到群机器人。"
  echo "config.conf 里还没填 notify.feishuWebhook，现在可以直接配置。"
  echo "贴入群机器人地址即写入 config.conf；直接回车跳过（以后也能在 config.conf 里补）。"
  while :; do
    printf 'webhook 地址（回车跳过）：'
    WEBHOOK_IN=""
    if ! read -r WEBHOOK_IN; then
      echo
      yellow "（读不到输入，跳过飞书通知配置；非交互安装可用 --test-webhook=<地址>）"
      return 0
    fi
    # 复制粘贴常带首尾空白，顺手去掉（含 \r）。地址内部不许再有空白、引号、
    # 反斜杠或 #：conf_set 走 awk -v，反斜杠会被当转义序列；conf_get 会把 #
    # 之后当注释截掉。这两种情况都会让写进去的地址和用户输入的不一样。
    WEBHOOK_IN="$(printf '%s' "$WEBHOOK_IN" | /usr/bin/awk '{ gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print }')"
    if [ -z "$WEBHOOK_IN" ]; then
      echo "已跳过飞书通知配置。"
      return 0
    fi
    case "$WEBHOOK_IN" in
      http://*|https://*) ;;
      *) red "地址要以 http:// 或 https:// 开头（收到：${WEBHOOK_IN}）"; continue ;;
    esac
    case "$WEBHOOK_IN" in
      *[[:space:]]*|*'"'*|*"'"*|*'\'*|*'#'*)
        red "地址里不能含空格、引号、反斜杠或 #，请重新粘贴"
        continue ;;
    esac
    if [ "${#WEBHOOK_IN}" -gt 2048 ]; then
      red "地址太长了（${#WEBHOOK_IN} 字符），请检查是否粘错"
      continue
    fi
    if conf_set notify.feishuWebhook "$WEBHOOK_IN"; then
      green "✓ 已写入 config.conf 的 notify.feishuWebhook（装完会发一条测试消息，请到群里查看）"
    else
      red "✗ 没能写入 config.conf，安装继续；可稍后手动填写 notify.feishuWebhook"
    fi
    return 0
  done
}
prompt_webhook
echo

# ── 定时时间：从 config.conf 的 schedule.* 读 ──
#
# 这一组和别的配置**不一样**：它们在安装时被固化进 plist，不是脚本运行时才读的。
# launchd 靠 plist 决定什么时候叫醒任务，脚本跑起来时已经晚了 —— 它只能决定
# "要不要继续"，决定不了"什么时候被叫醒"。所以改完必须重跑本脚本。
#
# 校验刻意严格：格式错了直接中止，绝不"猜一个时间先装上"。一个错的时间比没有
# 定时任务更难发现 —— 用户只会以为它没跑成功。

TIMES_RAW="$(conf_get schedule.times)"
TIMES_RAW="${TIMES_RAW:-03:33,13:33}"    # 没配就用模板默认值

CAL_ITEMS=""
CAL_HUMAN=""
TIME_COUNT=0

IFS=',' read -r -a _times <<< "$TIMES_RAW"
for _t in "${_times[@]}"; do
  _t="${_t//[[:space:]]/}"
  [ -n "$_t" ] || continue
  if [[ ! "$_t" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]]; then
    red "config.conf 的 schedule.times 格式不对：${_t}"
    red "  要求 HH:MM（24 小时制），多个用逗号分隔，例如：03:33,13:33"
    exit 1
  fi
  # 10# 前缀：bash 会把 08 / 09 当八进制，直接 $((08)) 会报错退出
  _h=$((10#${BASH_REMATCH[1]}))
  _m=$((10#${BASH_REMATCH[2]}))
  CAL_ITEMS="${CAL_ITEMS}    <dict><key>Hour</key><integer>${_h}</integer><key>Minute</key><integer>${_m}</integer></dict>"$'\n'
  _hm="$(printf '%02d:%02d' "$_h" "$_m")"
  CAL_HUMAN="${CAL_HUMAN}${CAL_HUMAN:+ · }${_hm}"
  TIME_COUNT=$((TIME_COUNT + 1))
done

if [ "$TIME_COUNT" -eq 0 ]; then
  red "config.conf 的 schedule.times 是空的 —— 至少要有一个时刻"
  red "  想停掉定时任务请用 --uninstall，而不是把时间清空"
  exit 1
fi

INTERVAL_RAW="$(conf_get schedule.intervalSeconds)"
INTERVAL_RAW="${INTERVAL_RAW:-3600}"
if [[ ! "$INTERVAL_RAW" =~ ^[0-9]+$ ]]; then
  red "config.conf 的 schedule.intervalSeconds 必须是整数秒：${INTERVAL_RAW}"
  exit 1
fi
INTERVAL=$((10#$INTERVAL_RAW))

RUN_AT_LOAD_RAW="$(conf_get schedule.runAtLoad)"
case "$(printf '%s' "${RUN_AT_LOAD_RAW:-true}" | tr 'A-Z' 'a-z')" in
  false|no|0|off) RUN_AT_LOAD=0 ;;
  true|yes|1|on)  RUN_AT_LOAD=1 ;;
  *)
    red "config.conf 的 schedule.runAtLoad 只能是 true / false（收到：${RUN_AT_LOAD_RAW}）"
    exit 1
    ;;
esac

# 关掉的那一项就整段不写 —— 不写 <false/>、也不写 0。
# launchd 对 StartInterval=0 的处理没有定义，与其猜语义，不如不写这个键。
RUN_AT_LOAD_BLOCK=""
INTERVAL_BLOCK=""
if [ "$RUN_AT_LOAD" -eq 1 ]; then
  RUN_AT_LOAD_BLOCK="  <key>RunAtLoad</key><true/>"
fi
if [ "$INTERVAL" -gt 0 ]; then
  INTERVAL_BLOCK="  <key>StartInterval</key><integer>${INTERVAL}</integer>"
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

TMP_PLIST="$(mktemp -t doubao-plist)"
cat > "$TMP_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <!-- 由 doubao-checkin.sh 自己找 node；以后换 node 也不用改这里 -->
  <key>ProgramArguments</key>
  <array>
    <string>$RUN_SH</string>
    <string>--quiet</string>
  </array>

  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>

  <!-- 日志目录由 config.conf 的 logDir 决定，这里只给 launchd 层的 stdout/stderr 兜底 -->

  <!-- 每天的时刻：来自 config.conf 的 schedule.times，安装时固化进 plist -->
  <key>StartCalendarInterval</key>
  <array>
${CAL_ITEMS}  </array>

  <!-- 来自 schedule.runAtLoad：任务被加载（≈ 用户登录）时补跑一次 -->
${RUN_AT_LOAD_BLOCK}

  <!-- 来自 schedule.intervalSeconds：固定间隔兜底；0 时这一项整段不出现 -->
${INTERVAL_BLOCK}

  <key>StandardOutPath</key><string>$LOG_DIR/checkin.out</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/checkin.err</string>

  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>

  <!-- 单次运行超过 5 分钟就杀掉，防止卡死一直占着锁 -->
  <key>ExitTimeOut</key><integer>300</integer>
</dict>
</plist>
PLISTEOF

if [ "${DRY:-0}" = "1" ]; then
  echo "# 将写入 $PLIST"
  cat "$TMP_PLIST"
  rm -f "$TMP_PLIST"
  exit 0
fi

# 重装检测必须在**覆盖文件之前**判断：
# 放在写文件之后，`[ -f "$PLIST" ]` 永远为真，首次安装也会报"检测到已安装"
WAS_INSTALLED=0
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || [ -f "$PLIST" ]; then
  WAS_INSTALLED=1
fi

mv "$TMP_PLIST" "$PLIST"

# 兜底检查：plist 里绝不能出现 ~，launchd 不解析它
if /usr/bin/grep -q '~/' "$PLIST"; then
  red "plist 中出现了 ~，launchd 无法解析。已中止，未注册。"
  rm -f "$PLIST"
  exit 1
fi

# 重装时不要每步都报告一遍，只把结论体现在这一行里
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

if [ "$WAS_INSTALLED" = "1" ]; then
  green "✓ 已更新 ${LABEL}（覆盖旧任务）"
else
  green "✓ 已安装 ${LABEL}"
fi
# 时间从**实际写进 plist 的值**回显，不另抄一份常量 —— 抄的那份迟早和 plist 不一致
_extra=""
if [ "$RUN_AT_LOAD" -eq 1 ]; then _extra=" · 登录补跑"; fi
if [ "$INTERVAL" -gt 0 ]; then
  if [ "$INTERVAL" -ge 60 ]; then
    _iv="$((INTERVAL / 60)) 分钟"
  else
    _iv="${INTERVAL} 秒"
  fi
  _extra="${_extra} · 每 ${_iv}兜底"
fi
echo "  时间  ${CAL_HUMAN}${_extra}"
if [ "$RUN_AT_LOAD" -eq 0 ]; then
  yellow "  注意  已关闭 schedule.runAtLoad：装完不会立刻跑，要等上面第一个时刻"
fi
echo "  日志  ${PROJECT_DIR}/scripts/doubao-checkin.sh --log    （签到约 30~60 秒，稍等再看）"
echo "  卸载  ${PROJECT_DIR}/scripts/install-launchd.sh --uninstall"
echo

# ── 飞书 webhook 自检：装完了才说「安装完成」 ──
#
# 为什么放在 bootstrap 之后：消息第一行就是「定时任务安装完成」，加载之前发是
# 谎报；而且自检失败只警告、不阻断安装，放后面没有代价。bootstrap 若失败，
# set -e 会先退出，也就根本不会发出这条消息。
#
# 为什么不调 scripts/doubao-checkin.sh --test-webhook：那个开关附着在**一次真实
# 签到**上（会拉起/重启客户端、内容取决于页面状态）；自检只验通知通道，不该把
# 豆包状态卷进来。向导确实会因 RunAtLoad 顺带跑一次签到，但那是 bootstrap 之后
# 的 --quiet 定时任务，按过滤规则推送，不是一条内容固定的自检消息。
#
# 消息内容：安装完成 + 主机名 + 签到脚本绝对路径（即 plist 里实际执行的那个）。
# 地址来源有三处，优先级同下：--test-webhook=<地址> > 交互询问刚写进的 config.conf
# > config.conf 里早就填好的。三者都没配 → webhook-test.mjs 输出 SKIP，静默略过。
WEBHOOK_SELFTEST_ARGS=(--script="$RUN_SH")
if [ -n "$WEBHOOK_URL_ARG" ]; then
  WEBHOOK_SELFTEST_ARGS=(--url="$WEBHOOK_URL_ARG" --script="$RUN_SH")
fi
WEBHOOK_TEST="$("$NODE_BIN" "$PROJECT_DIR/bin/webhook-test.mjs" "${WEBHOOK_SELFTEST_ARGS[@]}" 2>&1)" && WEBHOOK_RC=0 || WEBHOOK_RC=$?
case "$WEBHOOK_TEST" in
  OK*)  green "✓ 已推送测试消息到飞书群，请到群里查看" ;;
  SKIP) : ;;
  *)    yellow "⚠ webhook 自检未通过：${WEBHOOK_TEST#ERR }"
        yellow "  安装继续；可重跑 ./scripts/install-launchd.sh --test-webhook=<地址> 单独复验" ;;
esac
if [ -n "$WEBHOOK_URL_ARG" ] && [ -z "$(conf_get notify.feishuWebhook)" ]; then
  yellow "  注意  参数里的地址只用于这条测试消息；定时任务仍从 config.conf 读，"
  yellow "        请把地址填进 notify.feishuWebhook，或重跑不带参数的交互安装按提示填写，"
  yellow "        否则定时任务不会推送。"
fi
if [ "$WEBHOOK_TEST" != "SKIP" ]; then echo; fi

if [ "${RUN_NOW}" = "1" ]; then
  # -k 会先杀掉正在跑的实例再启动；这里不用 -k，正常排队即可
  launchctl kickstart "gui/$(id -u)/${LABEL}"
  echo "已按 --run-now 再触发一次。"
fi
