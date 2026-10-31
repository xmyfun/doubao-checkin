/**
 * 对外的名字与 `--help` 文本 —— **唯一来源**。
 *
 * help 必须只有一份。它是用户了解全部参数的唯一入口，一旦出现第二份副本，
 * 加参数时就会漏改其中一处，然后用户看到的帮助和你以为的不一样。
 * 所以 `bin/cli.mjs` 和 `bin/checkin.mjs` 都从这里 import 同一个常量，
 * `test/cli.test.mjs` 也用这份文本做校验。
 */

/** 本工具对外的名字：弹窗标题、终端第一行、help 首行，全用它 */
export const APP_TITLE = '豆包客户端自动签到';

export const HELP = `${APP_TITLE}

用法
  ./scripts/doubao-checkin.sh                  跑一次签到
  ./scripts/doubao-checkin.sh [选项]           带选项跑签到
  ./scripts/doubao-checkin.sh --calibrate      校准忙闲阈值（推荐，见下）

日常
  --log[=N]            最近 N 次运行记录（默认 20）
  --dry-run            只看不签：读到页面状态但不点按钮
  --ignore-history     无视「今天已签」的本地缓存，强制复查

校准（换机器、或客户端大版本更新后建议做一次）
  --calibrate          交互式校准忙闲阈值，最后可以写回 config.conf
                       可选：--interval=3  --idle=30  --fallback=30  --out=<路径.csv>

检查（都不动客户端）
  --doctor             环境诊断：进程 / 端口 / 页面 / 缓存 / 上次退出方式
  --verbose            打印端口列表与逐样本数据

修复（客户端白屏、点不动时用；会重启客户端，先问你）
  --repair             结束全部进程 → 清 GPU 缓存（先备份）→ 重启，三步一起做
  --yes                跳过 --repair 的确认，直接执行

其他选项
  --allow-relaunch     允许重启「正在运行的普通模式」豆包（会先查忙不忙）
  --json               机器可读输出
  --quiet              只在出错时输出
  --no-notify          失败时不弹窗
  --create-config      用内置模板生成一份 config.conf（已存在则不动）
  --version            显示版本号
  --help, -h           显示这份说明

node（由 scripts/doubao-checkin.sh 处理，不需要 node 就能跑）
  --which-node         只检查 node 能不能找到（和定时任务同一套逻辑）
  --find-node          列出运行时按什么顺序找 node、实际会用哪个，以及机器上还有哪些
                       （可选 --all 连 ~/Library/Application Support 的深目录一起扫）
  --install-node       下载一份 node 到 vendor/（找不到可用 node 时用）

定时任务
  ./scripts/install-launchd.sh              安装 / 重装
  ./scripts/install-launchd.sh --status     查看是否在运行
  ./scripts/install-launchd.sh --uninstall  卸载

行为配置在 config.conf（首次运行会自动用内置模板生成一份，不依赖磁盘上的
config.conf.template）；命令行参数优先级更高。

例外：schedule.* 那几项（运行时刻 / 登录补跑 / 兜底间隔）写进 launchd 的 plist，
改完要重跑一次 ./scripts/install-launchd.sh 才生效。`;
