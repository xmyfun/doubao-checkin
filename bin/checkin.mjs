#!/usr/bin/env node
/**
 * 豆包「天天领额度」每日签到 · macOS
 *
 * 设计原则（照搬 workbuddy-auto-signin 的工程纪律，不照搬它的取凭证方式）：
 *   1. 先查后领 —— 已签到立刻退出 0，不发任何写请求
 *   2. 幂等 —— 重复运行不会多领
 *   3. 不猜成功 —— 只认 DOM 状态变化，不认接口返回值
 *   4. UNKNOWN 不重试 —— 结构不认识时宁可什么都不做
 *   5. 时间预算 —— 超时主动收尾，写出结果后再退出
 *
 * 用法：
 *   node bin/checkin.mjs              # 签到（端口没开则报错，不擅自重启）
 *   node bin/checkin.mjs --allow-relaunch # 允许重启客户端以开启调试端口
 *   node bin/checkin.mjs --dry-run    # 只判定，不点击
 *   node bin/checkin.mjs --json       # 机器可读输出
 *   node bin/checkin.mjs --doctor     # 环境诊断
 *
 * 退出码：0 成功/已签 · 1 失败 · 2 参数错误 · 3 未登录 · 4 页面结构不认识
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { APP, EXIT } from '../src/app-profile.mjs';
import { judge } from '../src/state.mjs';
import { acquireLock } from '../src/lock.mjs';
import { notify } from '../src/notify.mjs';
import { isPortInUse, isDoubaoEndpoint, findDoubaoCdpPort, pickFreePort, portConflicts } from '../src/port.mjs';
import {
  writeRun, appendHistory, readHistory, summarize, logPath, logDir, setLogDir,
  displayWidth as dispWidth, wrapDisplay,
} from '../src/log.mjs';
import { loadSettings, createConf, CONFIG_PATH } from '../src/settings.mjs';
import { probeBusy } from '../src/busy.mjs';
import { breakerState } from '../src/breaker.mjs';
import {
  readExitType, cacheStatus, appMtime, formatAge, cacheTotalBytes, humanBytes,
  GPU_CACHE_DIRS, USER_DATA_DIR,
} from '../src/health.mjs';
import { APP_TITLE, HELP } from '../src/help.mjs';
import { backupAndClearCaches } from '../src/cache-clean.mjs';

/** 读取 config.conf 后的生效配置（main 里加载）。命令行参数已在加载时覆盖 */
let PREFS = null;

const argv = new Set(process.argv.slice(2));
const rawArgs = process.argv.slice(2);
const logArg = rawArgs.find((a) => a === '--log' || a.startsWith('--log='));

/**
 * 参数语义（名字必须直白）：
 *
 *   --allow-relaunch   允许**重启一个正在运行的**客户端。
 *                      注意：客户端没启动时随时可以带端口拉起（安全，不打断任何人），
 *                      客户端带 CDP 在跑时直接复用 —— 这两种情况都不需要这个参数。
 *   --ignore-history   忽略本地 history 缓存，强制去页面复查真实状态。
 */
const FLAG = {
  allowRelaunch: argv.has('--allow-relaunch'),
  allowRelaunchGiven: argv.has('--allow-relaunch'), // 用来区分"没写"和"写了 false"，配置合并且靠它
  ignoreHistory: argv.has('--ignore-history'),
  dryRun: argv.has('--dry-run'),
  json: argv.has('--json'),
  doctor: argv.has('--doctor'),
  quiet: argv.has('--quiet'),
  noNotify: argv.has('--no-notify'),
  verbose: argv.has('--verbose'),
  createConfig: argv.has('--create-config'),
  repair: argv.has('--repair'),
  yes: argv.has('--yes'),
  version: argv.has('--version'),
  log: !!logArg,
  logCount: logArg?.includes('=') ? Number(logArg.split('=')[1]) || 20 : 20,
};

// 拼错/不存在的参数直接失败：绝不带着未知参数继续跑 ——
// 否则 `--calibrate-busy`、`--dryrun` 这类手滑会变成"真的去点了一次签到"。
// 也不设参数别名：一个语义只对应一个名字，否则两套写法都得测，总会漏一个。
const KNOWN = new Set([
  '--allow-relaunch', '--ignore-history', '--dry-run', '--json', '--doctor',
  '--quiet', '--no-notify', '--verbose', '--log', '--help', '-h', '--create-config',
  '--repair', '--yes', '--version',
]);
const unknown = rawArgs.filter((a) => a.startsWith('--') && !KNOWN.has(a.split('=')[0]));
const wantsHelp = argv.has('--help') || argv.has('-h');
if (unknown.length && !wantsHelp) {
  console.error(`[错误] 未知参数：${unknown.join(' ')}`);
  // 从 KNOWN 生成，避免第三份手写清单
  console.error(`  可用参数：${[...KNOWN].filter((f) => f.startsWith('--')).join(' ')}`);
  process.exit(EXIT.APP);
}

// 修复会打断用户手上的活，只能由人发起。放在这里（而不是 main 里）是因为
// main 前面还有「今天已签就跳过」的缓存判断 —— 那会先一步把 --quiet 的修复
// 偷偷变成一条 SKIPPED 记录，用户以为跑了其实什么都没做。
if (FLAG.repair && FLAG.quiet) {
  console.error('[错误] 定时任务里不执行修复（--quiet），请手动运行：--repair');
  process.exit(EXIT.APP);
}

// APP_TITLE 来自 src/help.mjs —— 终端第一行、弹窗标题、--help 首行共用同一份文本

/**
 * 项目根目录，以及 repair 的缓存备份位置。
 *
 * 备份**不放 logs/**：logs 是给人读的运行记录，混进一堆 5~7MB 的二进制缓存会让
 * `--log`、排查、打包都变得难处理。backup/ 是纯垃圾桶，已进 .gitignore，随时可删。
 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = join(PROJECT_ROOT, 'backup');

/**
 * 本工具自身的版本号 —— **唯一来源是 `package.json` 的 `version` 字段**。
 * 不在这里写死一份：版本号散在两处，升级时必有一处忘改。
 * 读不到就返回 unknown，别让 `--version` 自己变成一次失败。
 */
function toolVersion() {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
}

/**
 * 弹窗去抖时长（毫秒），来自 config.conf 的 notify.debounceHours。
 *
 * 为什么要兜底：PREFS 在 main() 里才加载，而 run() 的 catch 可能在它之前就触发
 * （参数错误、配置文件读不了）。那时 PREFS 还是 null，用可选链退回默认 6 小时。
 */
const notifyDebounceMs = () => (PREFS?.notify?.debounceHours ?? 6) * 3600_000;

const EXE = `${APP.app}/Contents/MacOS/Doubao`;
const HELPER_APP = `${APP.app}/Contents/Helpers/Doubao Browser.app`;
const FRAMEWORK = `${HELPER_APP}/Contents/Frameworks/Doubao Browser Framework.framework`;

/** 运行时状态：端口是动态的，而且要知道"客户端是不是我们动的" */
const runtime = {
  port: null,        // 实际使用的端口
  mode: 'reuse',     // reuse（复用已有的）| restarted（本在运行但无端口）| launched（本未运行）
  wasRunning: false,
};

const base = () => `http://127.0.0.1:${runtime.port}`;

const startedAt = Date.now();
/** 运行过程，带时间戳，最后原样写进日志文件 */
const timeline = [];
function say(s = '') {
  timeline.push({ at: Date.now(), msg: s });
  if (!FLAG.json && !FLAG.quiet) console.log(s);
}

/** 中文按 2 列宽计，保证中英混排时标签对齐（实现在 src/log.mjs，测试也在那里） */

/**
 * 输出分两级，全文只有这一套：
 *
 *   一级（行）：`标签 + 取值`，取值从第 13 列开始，标签右补空格
 *               动作        重启客户端 · 端口 9225
 *   二级（细）：缩进到取值列，前面加 `·` —— 上一行的细节/进展
 *               动作        重启客户端 · 端口 9225
 *                            · 等待退出 1s：调试端口已关闭
 *               警告用 `⚠` 代替 `·`。
 *
 * 两级混在一起时，一眼看不出哪行是结论、哪行是过程细节。
 */
const LABEL_W = 12;
function line(label, text = '', width = LABEL_W) {
  return `${label}${' '.repeat(Math.max(1, width - dispWidth(label)))}${text}`;
}
function sayLine(label, text = '') { say(line(label, text)); }
/** 二级行：过程细节，缩进到取值列 */
function sub(text = '') { say(`${' '.repeat(LABEL_W)}· ${text}`); }
/** 二级行：可恢复的问题（不影响结论） */
function subWarn(text = '') { say(`${' '.repeat(LABEL_W)}⚠ ${text}`); }
function hr() { say('─'.repeat(56)); }
const remaining = () => APP.budgetMs - (Date.now() - startedAt);

// ────────────────────────────── 客户端发现 ──────────────────────────────

function plist(key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, `${APP.app}/Contents/Info.plist`], { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

function chromiumVersion() {
  try {
    return readdirSync(`${FRAMEWORK}/Versions`).filter((v) => v !== 'Current').sort().pop() || null;
  } catch { return null; }
}

function discover() {
  if (!existsSync(EXE)) {
    throw fail(`找不到客户端：${EXE}`, EXIT.APP);
  }
  return {
    exe: EXE,
    version: plist('CFBundleShortVersionString'),
    bundleId: plist('CFBundleIdentifier'),
    chromium: chromiumVersion(),
    hasHelper: existsSync(HELPER_APP),
  };
}

/**
 * 只要客户端版本号，而且**永远不抛异常**。
 *
 * 为什么要单独一个函数：读 Info.plist 不需要客户端在运行、也不需要开端口，
 * 所以连「今天已签、直接跳过」这种连客户端都不碰的记录也能带上版本号。
 * 排查时最常问的一句就是"那会儿客户端是哪个版本"，没有它就得靠猜。
 */
function clientVersion() {
  const v = plist('CFBundleShortVersionString');
  return v && v !== 'unknown' ? v : null;
}

/**
 * 上一次运行记录的客户端版本（取自 history.jsonl）。
 *
 * 用途只有一个：发现**客户端被静默升级**了。豆包自动更新不会通知用户，
 * 而 `src/app-profile.mjs` 的 cardSelector 是跟版本耦合的 —— 改版就可能失配。
 * 提前说一句，比等凌晨失败、早上看弹窗要好。
 *
 * @returns {string|null} 没有历史、或旧记录没带 client 字段时返回 null（首次运行不提示）
 */
function lastRecordedVersion() {
  try {
    const rows = readHistory(20);
    return rows.find((r) => typeof r.client === 'string' && r.client)?.client ?? null;
  } catch { return null; }
}

// ────────────────────────────── CDP ──────────────────────────────

async function cdpVersion(port = runtime.port) {
  if (!port) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** 僵尸进程：已经退出、只等父进程回收，不算"还在运行" */
function isZombie(pid) {
  try {
    const st = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return st.startsWith('Z');
  } catch { return false; }
}

function rawPids() {
  try {
    return execFileSync('pgrep', ['-f', EXE], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

/**
 * 还在运行的主进程。
 *
 * 注意排除僵尸：客户端点退出后进程会立刻消失，但内核里那条记录要等父进程
 * 回收才清掉，`pgrep` 这段时间仍能列出它。实测就是这样 —— 用户看到窗口
 * 已经关了，脚本却还在等 15 秒，最后白白补了一刀 SIGKILL。
 */
function mainPids() {
  const all = rawPids();
  const alive = all.filter((p) => !isZombie(p));
  if (alive.length < all.length && alive.length === 0) {
    // 只在"全部是僵尸"时说一句，避免刷屏
    runtime.zombies = all;
  }
  return alive;
}

function isRunning() { return mainPids().length > 0; }

/** 超时时把"到底还剩什么"打出来，别再靠猜 */
function describePids() {
  const all = rawPids();
  if (!all.length) return '（无）';
  return all.map((p) => {
    let cmd = '';
    try { cmd = execFileSync('ps', ['-o', 'command=', '-p', String(p)], { encoding: 'utf8' }).trim(); } catch { cmd = '?'; }
    return `pid ${p}${isZombie(p) ? ' [僵尸]' : ''}  ${cmd.slice(0, 80)}`;
  }).join(' | ');
}

/**
 * 决定用哪个端口、要不要动客户端。
 *
 * 三种情况：
 *   reuse      —— 已经有豆包带端口在跑（可能是用户自己开的），不动客户端
 *   restarted  —— 客户端在跑但没有端口，重启它；签完要恢复成正常模式
 *   launched   —— 客户端没开，我们拉起它；签完要退出，恢复成"没开"
 */
async function resolveEndpoint() {
  // ① 起点端口来自 config.conf 的 cdpPort（schema 已校验 1024~65535）；
  //    被占用时会自动往后找，所以这只是"起点"而不是"必须用这个"。
  let startPort = PREFS?.cdpPort ?? APP.port;

  // ② 客户端进程在运行吗
  const running = isRunning();

  // ③ 在运行的话，先问进程它监听了哪些端口，再逐个验证哪个是 CDP
  //    —— 不猜端口号，豆包一个进程会开 19 个端口，只有一个是 CDP
  if (running) {
    const { port, ports } = await findDoubaoCdpPort();
    // 列表太长（实测 31 个），只在需要排查时展开
    if (FLAG.verbose || FLAG.doctor) {
      sayLine('监听端口', ports.length ? ports.join(' ') : '（无）');
    }
    if (port) {
      runtime.port = port;
      runtime.mode = 'reuse';
      sayLine('检测', `进程运行中 · CDP 已开启 → ${port}，直接复用`);
      return await cdpVersion(port);
    }
    sayLine('检测', `进程运行中 · CDP 未开启（${ports.length} 个监听端口里没有 CDP 端点）`);
  } else {
    sayLine('检测', '进程未运行');
  }

  // ④ 客户端没启动 → 随时可以带端口拉起，安全（不打断任何人），不需要任何参数。
  //    客户端已启动但没 CDP → 这才是"重启"，必须显式授权。
  if (running && !PREFS?.allowRelaunch) {
    throw fail(
      '豆包正在运行，但不是带调试端口启动的（普通方式启动）。\n' +
      '  签到需要带调试端口重启一次它，这会打断你正在进行的对话。\n' +
      '  在 config.conf 里把 allowRelaunch 设为 true，或临时加 --allow-relaunch。\n' +
      '  或者：先 Cmd+Q 退出豆包再跑，那样不会打断任何东西。',
      EXIT.APP
    );
  }

  runtime.wasRunning = running;
  runtime.mode = running ? 'restarted' : 'launched';

  // ⑤ 从起点端口开始找空闲的，被占就往后挪；启动后不就绪则换端口重试
  const tried = [];
  for (let attempt = 1; attempt <= APP.portRetries; attempt++) {
    if (remaining() < 30000) {
      subWarn('时间预算不足，停止重试');
      break;
    }

    const port = await pickFreePort(startPort, APP.portScanRange, tried);
    if (!port) {
      throw fail(`从 ${startPort} 起 ${APP.portScanRange} 个端口都不可用`, EXIT.FAIL);
    }
    tried.push(port);

    if (port !== startPort && attempt === 1) {
      sayLine('端口', `${startPort} 已被占用，改用 ${port}`);
    }
    sayLine('动作', `${runtime.wasRunning ? '重启' : '启动'}客户端 · 端口 ${port}${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}`);

    if (await launchWithPort(port)) {
      runtime.port = port;
      return await cdpVersion(port);
    }

    subWarn(`端口 ${port} 启动后未就绪，清理后换端口重试…`);
    await quitClient();
  }

  throw fail(
    `尝试 ${tried.length} 个端口（${tried.join(', ')}）后仍未拿到**可读**的 CDP 端点。\n` +
    `  常见原因：\n` +
    `    1. 沙箱环境吞掉了启动参数（在 IDE 的 Agent 沙箱、容器里跑就会这样）\n` +
    `    2. 客户端启动不完整（窗口空白、页面无响应）\n` +
    `    3. 端口被防火墙拦截\n` +
    `  请在【终端】里手动验证一次：\n` +
    `    open -a "${APP.app}" --args --remote-debugging-port=${PREFS?.cdpPort ?? APP.port}\n` +
    `    curl --noproxy '*' http://127.0.0.1:${PREFS?.cdpPort ?? APP.port}/json/version`,
    EXIT.FAIL
  );
}

/**
 * 端口通了不等于能用。
 *
 * 实测（2.32.6）：直接执行 Contents/MacOS/Doubao 能 2 秒开出 CDP 端口，
 * /json/list 也正常返回 5 个 target，但客户端窗口是**空的**，
 * 所有 target 的 Runtime.evaluate 全部挂起 —— 渲染进程根本没起来。
 *
 * 所以「启动成功」只能用「能不能 evaluate」来判定，不能只看端口。
 */
async function cdpResponsive(port, timeoutMs = 1500) {
  let targets;
  try { targets = await listTargets(port); } catch { return false; }

  // 优先挑豆包自己的页面：刚启动时列表里可能有空 url 的占位 target，
  // 它们不一定有渲染进程，先试它们会白白浪费掉整段等待时间。
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ordered = [
    ...pages.filter((t) => (t.url || '').startsWith('doubao://')),
    ...pages.filter((t) => !(t.url || '').startsWith('doubao://')),
  ];

  for (const t of ordered.slice(0, 4)) {
    try {
      await evaluate(t.webSocketDebuggerUrl, 'JSON.stringify({ok:1})', timeoutMs);
      return true;
    } catch { /* 换下一个 target 试 */ }
  }
  return false;
}

/**
 * 带指定端口启动客户端，并等到 CDP 真的**可读**。
 *
 * 只用 `open -a <app> --args --remote-debugging-port=N`（走 LaunchServices）。
 * 另一种写法是直接执行 Contents/MacOS/Doubao，**已实测否决**：
 * 它能 2 秒开出端口、target 列表也正常，但客户端是空壳（窗口空白、
 * 所有 target 的 Runtime.evaluate 全部挂起），比启动失败更糟 ——
 * 用户会看到一个打不开的窗口，脚本还要等到超时。
 *
 * 关于 `open --args` 的一个重要事实（2026-10-23 实测）：
 *   - 用户终端里跑 → 参数正常传入，端口正常，客户端完整
 *   - 沙箱化的 Agent shell / CI 里跑 → 参数被吞，主进程 argv 为空，
 *     helper 只收到 `--saman-from-chat=<pid>`，端口永远不出现
 * 所以这个函数在沙箱里天然测不出来，但 launchd（非沙箱的普通用户进程）没问题。
 */
async function launchWithPort(port) {
  const quit = await quitClient();

  // 关键：如果旧进程没能结束，`open` 只会「激活」它而不是带参数重启 ——
  // LaunchServices 认为这个 app 还在运行，直接把 argv 丢掉。
  // 这种时候继续往下走只会白等三个端口，所以这里直接失败并说清原因。
  if (isRunning()) {
    throw fail(
      `客户端无法结束（${quit.how}，${(quit.ms / 1000).toFixed(1)}s 后进程仍在）。\n` +
      `  此时 open 只会激活已有实例、不会带 --remote-debugging-port 重启，端口永远不会出现。\n` +
      `  请先手动 Cmd+Q 退出豆包（或强制结束），再重试。`,
      EXIT.FAIL
    );
  }

  spawn('open', ['-a', APP.app, '--args', `--remote-debugging-port=${port}`], {
    detached: true, stdio: 'ignore',
  }).unref();

  const deadline = Date.now() + APP.launchTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (remaining() < 20000) return false;
    if (!(isPortInUse(port) && await isDoubaoEndpoint(port))) continue;
    // 端口在监听了，再确认页面真的能读 —— 空壳客户端会卡在这里。
    // 注意必须把 port 传进去：此时 runtime.port 还没赋值。
    if (await cdpResponsive(port)) return true;
  }
  if (isPortInUse(port)) {
    subWarn(`端口 ${port} 已监听，但页面无响应（客户端启动不完整）`);
  }
  return false;
}

/** 等进程真的消失，返回是否已退出 */
async function waitGone(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isRunning()) return true;
    await sleep(300);
  }
  return !isRunning();
}

/**
 * 结束客户端。**永远优先优雅退出，绝不先 kill。**
 *
 * 三级递进，每一级都等它真的退出再决定要不要升级：
 *
 *   ① AppleScript `quit` —— 等价于 Cmd+Q，走 NSApplication 的正常终止流程，
 *      客户端能保存会话、写完脏数据。这是唯一"用户视角无损"的方式。
 *   ② SIGTERM —— GUI 应用不一定处理，但给了它一个收尾的机会。
 *   ③ SIGKILL —— 只在 ①② 都失败时用。会产生崩溃转储，绝不作为默认手段。
 *
 * 为什么不能直接 pkill：`pkill` 默认发 SIGTERM，对 AppKit 应用来说
 * 这不是 Cmd+Q —— 不经过 terminate 流程，登录态/会话可能来不及落盘。
 * 而 `pkill -9` 更糟：每次都会在 Crashpad 里留下一个 dmp。
 */
async function quitClient() {
  if (!isRunning()) return { how: 'not-running', ms: 0 };
  const t0 = Date.now();

  // ① 优雅退出（按 bundle id 精确指定，避免同名应用误伤）
  //
  // AppleScript 控制别的应用需要「自动化」权限（TCC）。第一次会弹
  // 「终端 想要控制 豆包」，被拒绝/超时的话 osascript 会立刻报错 ——
  // 这时**不要**再干等 8 秒，直接降级。日志里要写清是"没权限"还是"退得慢"，
  // 否则线上排查时完全看不出区别。
  const bundleId = plist('CFBundleIdentifier');
  if (bundleId && bundleId !== 'unknown') {
    let requested = false;
    try {
      execFileSync('/usr/bin/osascript', ['-e', `tell application id "${bundleId}" to quit`],
        { stdio: 'ignore', timeout: 10000 });
      requested = true;
    } catch {
      subWarn('AppleScript 无法控制豆包（多半是缺少「自动化」权限），改用 SIGTERM');
    }
    if (requested) {
      // 等待期间每 3 秒报一次"端口还在不在"，用来区分两种截然不同的情况：
      //   端口已关 + 进程还在 → 客户端其实已经退出了（引擎停了），只是进程还没被回收
      //   端口还在        → 客户端是卡住了，根本没在退出
      const deadline = Date.now() + APP.quitGraceMs;
      let lastLog = 0;
      while (Date.now() < deadline) {
        if (!isRunning()) return { how: 'quit', ms: Date.now() - t0 };
        if (Date.now() - lastLog > 3000) {
          lastLog = Date.now();
          const portAlive = runtime.port ? isPortInUse(runtime.port) : false;
          sub(`等待退出 ${((Date.now() - t0) / 1000).toFixed(0)}s：调试端口${portAlive ? '仍在监听' : '已关闭'}`);
        }
        await sleep(300);
      }
      subWarn(`优雅退出 ${APP.quitGraceMs / 1000} 秒未完成：${describePids()}`);
    }
  }

  // ①b 端口已关 = 浏览器引擎已经退了，进程只是还没被回收。
  // 这时候再补 SIGTERM/SIGKILL 毫无意义，还会多留一个崩溃转储。
  if (runtime.port && !isPortInUse(runtime.port)) {
    return { how: 'quit', ms: Date.now() - t0, lingering: true };
  }

  // ② SIGTERM
  try { execFileSync('pkill', ['-TERM', '-f', EXE]); } catch { /* ignore */ }
  if (await waitGone(APP.termGraceMs)) return { how: 'term', ms: Date.now() - t0 };
  subWarn(`SIGTERM ${APP.termGraceMs / 1000} 秒未完成`);

  // ③ 最后手段
  try { execFileSync('pkill', ['-9', '-f', EXE]); } catch { /* ignore */ }
  await waitGone(3000);
  return { how: 'kill', ms: Date.now() - t0 };
}

/**
 * 把客户端还原成我们来之前的样子。
 * 这是"端口只在签到时临时开一下"的落地：
 *   reuse     → 用户自己开的，什么都不做
 *   restarted → 原本在跑，重启回正常模式（不带端口）
 *   launched  → 原本没开，直接退出
 */
async function restoreClient() {
  // ⚠️ 白名单，不是黑名单：只有我们**真的动过**客户端（launched/restarted）才还原。
  // 用 `!== 'reuse'` 这种写法害过：判为忙而提前退出时 mode 是 null，
  // 会走到 quitClient 把用户正在用的豆包关掉 —— 正好是我们要避免的事。
  if (runtime.mode !== 'launched' && runtime.mode !== 'restarted') return;

  sayLine('还原', '处理客户端…');
  const quit = await quitClient();

  // 绝不能不加验证就宣布"已还原"：实测过优雅退出和 SIGTERM 都超时、
  // 进程其实还活着，但日志写的是"已退出"—— 假成功比失败更危险，
  // 因为它会让一个还开着调试端口（无鉴权）的客户端被当成已经关掉。
  const alive = isRunning();
  const portOpen = runtime.port ? isPortInUse(runtime.port) : false;
  const howText = { quit: '优雅退出', term: 'SIGTERM', kill: 'SIGKILL', 'not-running': '本来就没跑' }[quit.how] || quit.how;
  const costText = quit.ms > 0 ? `，${howText} ${(quit.ms / 1000).toFixed(1)}s` : '';
  const zombieText = runtime.zombies?.length
    ? `（有 ${runtime.zombies.length} 个僵尸进程 pid ${runtime.zombies.join(',')}，已忽略）` : '';
  const lingerText = quit.lingering && alive
    ? `（调试端口已关闭，进程 pid ${rawPids().join(',')} 残留待系统回收）` : '';

  // 判据是**调试端口关没关**，不是"进程死没死"。
  // 用户看得见的是窗口，安全相关的是端口；进程晚几秒消失并不影响任何事。
  if (runtime.mode === 'restarted') {
    if (portOpen) subWarn('调试端口仍未关闭，直接带正常模式重启');
    spawn('open', ['-a', APP.app], { detached: true, stdio: 'ignore' }).unref();
    sub(`已重启为普通模式（调试端口已关闭${costText}）${lingerText}${zombieText}`);
    return;
  }

  if (portOpen) {
    subWarn(`调试端口仍在监听（${howText}后仍存活）—— 请手动 Cmd+Q 关闭豆包`);
    runtime.leftover = true;
  } else {
    sub(`已退出（本来就未运行${costText}）${lingerText}${zombieText}`);
  }
}

// ────────────────────────────── 健康快照与修复 ──────────────────────────────

/**
 * 客户端的**全部**进程（主进程 + 全部 Helper）。
 *
 * 按 `.app` 路径匹配，而不是进程名：
 *   pgrep -f "/Applications/Doubao.app/"     → 主进程 + 所有 Helper（实测 15 个）
 *   pgrep -f ".../Contents/MacOS/Doubao"    → 只有主进程（1 个）
 *   pgrep -f "Doubao"                       → 连豆包输入法一起命中（错误）
 * 输入法装在 /Library/Input Methods/DoubaoIme.app/，路径完全不同，天然不会被带上。
 */
function allClientPids() {
  const root = `${APP.app.replace(/\/+$/, '')}/`;
  try {
    return execFileSync('pgrep', ['-f', root], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

async function waitAllClientGone(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!allClientPids().length) return true;
    await sleep(200);
  }
  return allClientPids().length === 0;
}

/** 一份健康快照。doctor 看它，repair 在修前修后各看一次。 */
function healthSnapshot() {
  const pids = allClientPids();
  const caches = cacheStatus(USER_DATA_DIR);
  return {
    running: pids.length > 0,
    totalPids: pids.length,
    mainPid: mainPids()[0] ?? null,
    exitType: readExitType(USER_DATA_DIR),
    caches,
    cacheBytes: cacheTotalBytes(caches),
    appMtimeMs: appMtime(APP.app),
  };
}

/**
 * 快照里和"进程"无关的那几行：缓存 / 退出记录 / 应用包。
 * 进程那行不放在这里 —— doctor 和 repair 的措辞不一样，各自打各自的。
 */
function sayHealth(s) {
  const cacheText = s.caches
    .map((c) => `${c.rel.split('/').pop()} ${c.exists ? formatAge(c.ageHours) : '不存在'}`)
    .join(' · ');
  sayLine('缓存', `${cacheText} · 共 ${humanBytes(s.cacheBytes)}`);
  sayLine('退出记录', s.exitType
    ? `${s.exitType}${s.exitType === 'Crashed' ? '（上次是异常退出）' : ''}`
    : '读不到');
  if (s.appMtimeMs) sayLine('应用包', `${stampOf(new Date(s.appMtimeMs))} 修改`);
}

/** 交互确认。读不到输入（管道/非终端）时按"取消"处理 —— 危险操作宁可不动。 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(question);
    return /^y(es)?$/i.test(ans.trim());
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/**
 * 结束客户端的**全部**进程：先 SIGTERM，等 5 秒，还活着的再 SIGKILL。
 *
 * 和 quitClient 的区别：那个只对主进程发信号（签到场景够了 —— 主进程退出时会
 * 自己带走子进程）。这里多发一轮全量 SIGKILL，因为修复的前提就是"主进程可能已经
 * 不响应了"，那种情况下它的子进程会变成孤儿继续占着端口。
 */
async function stopAllClient() {
  const before = allClientPids();
  if (!before.length) return { how: 'not-running', before: 0 };

  for (const p of before) { try { process.kill(Number(p), 'SIGTERM'); } catch { /* 已退出 */ } }
  if (await waitAllClientGone(5000)) return { how: 'term', before: before.length };

  const left = allClientPids();
  sub(`${left.length} 个进程没响应 SIGTERM，改用 SIGKILL`);
  for (const p of left) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* 已退出 */ } }
  await waitAllClientGone(3000);
  return { how: 'kill', before: before.length, killed: left.length };
}

/**
 * 列 target。
 *
 * ⚠️ 必须能显式传端口：启动流程里 `runtime.port` 要等 launchWithPort 返回成功
 * 才赋值，健康检查如果走 base()（依赖 runtime.port），就会请求
 * `http://127.0.0.1:null/json/list` 而 100% 失败 —— 表现为「客户端明明是好的，
 * 却被判定成启动不完整」，然后连续换 3 个端口全失败。
 */
async function listTargets(port = runtime.port) {
  if (!port) throw new Error('listTargets 需要明确的端口（此时 runtime.port 还没赋值）');
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  return await r.json();
}

/** 通用 CDP 调用（一次连接、一个请求、立即断开） */
async function cdpSend(wsUrl, method, params = {}, timeoutMs = 20000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP 连接超时')), Math.min(10000, timeoutMs));
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP 连接失败')); }, { once: true });
  });
  try {
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
      ws.addEventListener('message', (e) => {
        let d; try { d = JSON.parse(e.data); } catch { return; }
        if (d.id === 1) { clearTimeout(t); resolve(d); }
      });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    if (res.error) throw new Error(JSON.stringify(res.error));
    return res.result;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

async function evaluate(wsUrl, expression, timeoutMs = 20000) {
  const res = await cdpSend(wsUrl, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  }, timeoutMs);
  const v = res?.result?.value;
  if (typeof v !== 'string') throw new Error('页面返回非预期结构');
  return JSON.parse(v);
}

/**
 * 打开活动页 —— 只剩一条路：让 App 自己把活动页开进右侧边栏。
 *
 * 这两条路都**不能走**，走了会把用户正在用的客户端弄坏：
 *   · **新建 target**：多一个 web contents 让客户端退不掉，收尾必然 SIGKILL
 *     （`PUT /json/new` 单做这一步就能复现）。
 *   · **借聊天页导航过去**：2.34.6 上会让聊天页的渲染进程**整个卡死** ——
 *     实测导航后连 `1+1` 都求不出来，用户看到的就是"点什么都没反应、像断了网"
 *     （2026-10-31 实测）。
 *
 * 代价是：边栏点不开就只能放弃本次。少签一天可以接受，把客户端弄坏不可以。
 */
/**
 * 在聊天页里模拟点一个链接，让 App 自己把活动页开进右侧边栏。
 *
 * 这是**完全原生**的路径：实测点链接后 App 会创建 `type=webview` 的边栏容器
 * （和人点「签到领额度」一模一样），聊天页的 url 完全不变，客户端退出也只要 2 秒。
 *
 * 线索来自边栏状态里的 `source: "link_click"` —— App 会拦截聊天页里的链接点击，
 * 把目标 URL 开进右侧边栏，而不是在当前页导航。
 */
async function openPanelViaLink(chatTarget) {
  const ID = '__doubao_auto_signin_link__';

  // ⚠️ 2.34.6 起 App 检查 `event.isTrusted`：脚本合成的 dispatchEvent 会被放行成
  // 普通链接点击，外链被丢给**系统默认浏览器**（实测直接开了 Edge）。
  // 只有 CDP 的 Input.dispatchMouseEvent 注入的是真实鼠标事件，App 才会拦。
  //
  // 连带约束：链接必须在**视口内** —— Input 事件按坐标派发，屏幕外的元素点不到。
  // 所以用 opacity 接近 0 的 2×2 像素块，不能放在 `left:-9999px` 那种位置。
  const injectExpr = `(() => {
    document.getElementById(${JSON.stringify(ID)})?.remove();
    const a = document.createElement('a');
    a.id = ${JSON.stringify(ID)};
    a.href = ${JSON.stringify(APP.activityUrl)};
    a.target = '_self';   // 万一没被拦截，在当前页导航，也不要丢给系统浏览器
    a.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;z-index:2147483647';
    document.body.appendChild(a);
    const r = a.getBoundingClientRect();
    return JSON.stringify({ x: r.left + 1, y: r.top + 1 });
  })()`;

  const cleanExpr = `document.getElementById(${JSON.stringify(ID)})?.remove(); 1`;

  try {
    // 等界面**真的能用**，而不是"脚本环境就绪"就算完。
    //
    // 引擎起来得比界面早得多：`_aha_api` 和 `WebView` 在冷启动几百毫秒内就为真，
    // 但这时 React 还没挂载、App 的链接拦截器也可能没注册。用户实测过：
    // 这一段不等，点完要好几秒活动页才出来（而且可能点了没反应）。
    //
    // 所以多查两个界面标志：页面有实际内容（bodyLen）、聊天输入框已挂载。
    // 这两样都是"人能用它了"的硬指标，而且不依赖具体文案，改版不易失效。
    const READY = `JSON.stringify({
      aha: typeof window._aha_api === "object",
      wv: typeof WebView === "function",
      complete: document.readyState === "complete",
      bodyLen: (document.body && document.body.innerText || "").length,
      input: !!document.querySelector('textarea, [contenteditable="true"]'),
    })`;
    const readyOk = (r) => r?.aha && r?.wv && r?.complete && r.bodyLen > 100 && r.input;

    const waitStart = Date.now();
    let ready = null;
    let announced = false;
    for (let i = 0; i < 60; i++) {
      ready = await evaluate(chatTarget.webSocketDebuggerUrl, READY).catch(() => null);
      if (readyOk(ready)) break;
      // 只有"确实要等"时才提这一句。不解释在等什么，用户会以为卡住了。
      if (!announced) { sub('准备点链接打开边栏，先等界面就绪…'); announced = true; }
      if (remaining() < 15000) break;
      await sleep(300);
    }
    const waited = Date.now() - waitStart;
    if (readyOk(ready) && waited > 800) {
      sub(`界面已就绪（等了 ${(waited / 1000).toFixed(1)}s）`);
    } else if (!readyOk(ready)) {
      // 等不到也照点：界面慢不等于点击一定失败，只是成功率低一些。
      // 直接放弃的话，冷启动慢的机器会永远签不上。
      subWarn('界面看起来还没完全加载，仍尝试点击');
    }

    const pos = await evaluate(chatTarget.webSocketDebuggerUrl, injectExpr).catch(() => null);
    if (!pos) return null;

    const existed = new Set((await listTargets()).map((t) => t.id));

    // 这一句必须放在**真正发事件之前** —— 它是记录，不是预告。
    sub('点击链接，等 App 把它开进边栏…');

    // 先移动再按下抬起 —— 最接近人手的序列，也让 App 的 hover 逻辑走一遍
    await cdpSend(chatTarget.webSocketDebuggerUrl, 'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: pos.x, y: pos.y }, 5000).catch(() => null);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdpSend(chatTarget.webSocketDebuggerUrl, 'Input.dispatchMouseEvent',
        { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, 5000).catch(() => null);
    }

    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const now = await listTargets();
      const fresh = now.find((t) => t.type === 'webview' && !existed.has(t.id) && (t.url || '').includes('agent-explore'));
      if (fresh) {
        runtime.openedPanel = { pageTargetId: chatTarget.id, webviewId: fresh.id };
        return fresh;
      }
      if (remaining() < 15000) break;
    }
    return null;
  } finally {
    // 成败都要清掉注入的链接：留着它会覆在窗口左上角，用户点得到
    await evaluate(chatTarget.webSocketDebuggerUrl, cleanExpr).catch(() => null);
  }
}

async function openActivity() {
  const targets = await listTargets();

  // ① 边栏已经开着：原生容器，直接用，什么都不创建
  const native = targets.find((t) => t.type === 'webview' && (t.url || '').includes('pc/agent-explore'));
  if (native) {
    sub('复用已打开的原生边栏（不创建、不导航）');
    return { target: native, created: false, native: true };
  }

  const hit = targets.find((t) => (t.url || '').includes('pc/agent-explore'));
  if (hit) return { target: hit, created: false };

  // ② 主流路径：模拟点链接，让 App 自己开边栏
  const chat = targets.find((t) => t.type === 'page' && /^doubao:\/\/doubao-chat\/chat/.test(t.url || ''));
  if (chat) {
    const wv = await openPanelViaLink(chat);
    if (wv) {
      sub('原生边栏已打开');
      return { target: wv, created: false, viaLink: true };
    }
    subWarn('原生边栏没有出现（App 没有拦截链接点击）');
  }

  // ③ 没有兜底了 —— 两条旧路都在 2026-10-31 删除，原因不同：
  //
  //   · 「借聊天页 Page.navigate 过去」：2.34.6 上导航到外部 https 会把**聊天页的
  //     渲染进程整个卡死**。实测导航后连 `1+1` 都超时，用户看到的就是
  //     "点什么都没反应、像断了网"。它不只是没效果，是主动把客户端搞坏。
  //   · 「/json/new 新建标签」：多一个 web contents 让客户端退不掉，收尾必然 SIGKILL。
  //
  // 取舍：少签一天可以接受，把用户正在用的客户端弄坏不可以。
  // 这里直接放弃，交给下一次定时任务；客户端还原由 run() 的 catch 兜底。
  throw fail('原生边栏点不开（App 没有拦截链接点击），本次放弃。下次定时任务会再试', EXIT.FAIL);
}

// ────────────────────────────── 页面读取 ──────────────────────────────

const STATE_EXPR = `(() => {
  const SEL = ${JSON.stringify(APP.cardSelector)};
  const loginRe = new RegExp(${JSON.stringify(APP.loginPattern.source)});
  const pendingRe = new RegExp(${JSON.stringify(APP.pendingTextPattern.source)});
  const card = document.querySelector(SEL);
  const loginPrompt = loginRe.test((document.body && document.body.innerText) || '');

  // 页面画像：正常与失败都采，但只有轻量数字。
  //
  // 只记「正文 0 字」分不清两种完全不同的故障：
  //   资源全都没加载   → 网络/服务端问题，脚本无能为力
  //   资源都在、JS 没跑 → 前端脚本崩了，可能是缓存或客户端的问题
  // resPending 数的是「请求发出去了但没收到响应」的资源，这是最直接的信号；
  // htmlLen 用来区分「空文档」和「有骨架屏但没内容」—— 正文 0 字可能两者都成立。
  const pageInfo = () => {
    const res = performance.getEntriesByType('resource') || [];
    return {
      htmlLen: ((document.documentElement && document.documentElement.outerHTML) || '').length,
      resTotal: res.length,
      resPending: res.filter((r) => r.responseEnd === 0).length,
      online: navigator.onLine,
      visibility: document.visibilityState,
    };
  };

  if (!card) {
    const codes = [...document.querySelectorAll('[data-reward-code]')].map(n => n.getAttribute('data-reward-code'));
    return JSON.stringify({
      found: false, loginPrompt, url: location.href,
      readyState: document.readyState,
      bodyLen: (document.body && document.body.innerText || '').length,
      rewardCodes: codes,
      page: pageInfo(),
      bodyText: ((document.body && document.body.innerText) || '').replace(/\\s+/g,' ').slice(0, 400)
    });
  }
  const btn = [...card.querySelectorAll('button')]
    .find(b => pendingRe.test(b.innerText || ''));
  return JSON.stringify({
    found: true, loginPrompt, url: location.href,
    hasRewarded: new RegExp(${JSON.stringify(APP.rewardedPattern.source)}, 'i').test(card.innerHTML)
      || /已签到|明天再来|明日再来/.test(card.innerText || ''),
    buttonText: btn ? (btn.innerText || '').trim() : null,
    buttonDisabled: btn ? !!btn.disabled : null,
    page: pageInfo(),
    cardText: ((card.innerText) || '').replace(/\\s+/g,' ').trim().slice(0, 200)
  });
})()`;

const CLICK_EXPR = `(() => {
  const card = document.querySelector(${JSON.stringify(APP.cardSelector)});
  if (!card) return JSON.stringify({ ok:false, reason:'no-card' });
  const btn = [...card.querySelectorAll('button')]
    .find(b => new RegExp(${JSON.stringify(APP.pendingTextPattern.source)}).test(b.innerText || ''));
  if (!btn) return JSON.stringify({ ok:false, reason:'no-button' });

  const r = btn.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return JSON.stringify({ ok:false, reason:'button-invisible' });

  // React / Radix 会在 pointerdown 上挂事件，el.click() 静默无效。
  // 必须派发完整指针事件序列，坐标现算（窗口尺寸一变就错）。
  const opts = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
    button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse'
  };
  for (const type of ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click']) {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    try { btn.dispatchEvent(new Ctor(type, opts)); } catch (e) {
      btn.dispatchEvent(new MouseEvent(type, opts));
    }
  }
  return JSON.stringify({ ok:true, text:(btn.innerText || '').trim(), x:opts.clientX, y:opts.clientY });
})()`;

// ────────────────────────────── 主流程 ──────────────────────────────

function fail(message, code) {
  const e = new Error(message);
  e.exitCode = code;
  return e;
}

function showLog(n = 20) {
  const rows = readHistory(n);
  console.log(`日志目录  ${logDir()}`);
  console.log(`流水日志  ${logPath()}`);
  console.log('');
  if (!rows.length) {
    console.log('（还没有运行记录）');
    return;
  }
  // 按显示宽度补齐（中文算 2 列），否则中英混排的表头对不上
  const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dispWidth(String(s))));
  // 前面 5 列固定 48 列，剩下全给「说明」；跟着终端宽度走，窄终端下自动折得更早
  const HEAD = 17 + 9 + 7 + 6 + 9;
  const COLS = Math.max(HEAD + 24, Math.min(process.stdout.columns || 94, 120));
  const NOTE = COLS - HEAD;
  console.log([pad('时间', 17), pad('结果', 9), pad('耗时', 7), pad('端口', 6), pad('客户端', 9), '说明'].join(''));
  console.log('─'.repeat(COLS));
  for (const r of rows) {
    const d = new Date(r.at);
    const p = (x) => String(x).padStart(2, '0');
    const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-';
    const head = [
      pad(time, 17), pad(r.result, 9), pad(dur, 7), pad(r.port ?? '-', 6), pad(r.client || '-', 9),
    ].join('');
    // 说明文字折行，不截断 —— 不能让它从句子中间断掉（"…，本次" 后面没了）
    const lines = wrapDisplay(r.report || '', NOTE);
    lines.forEach((t, i) => console.log(i === 0 ? head + t : ' '.repeat(HEAD) + t));
  }
  const s = summarize(rows);
  console.log('─'.repeat(COLS));
  console.log(`近 ${rows.length} 次：签到 ${s.claimed} · 已签 ${s.already} · 遇忙 ${s.busy} · 其他跳过 ${s.skipped}`
    + `${s.circuit ? ` · 熔断 ${s.circuit}` : ''}`
    + `${s.repair ? ` · 修复 ${s.repair}` : ''}`
    + `${s.pending ? ` · 试运行 ${s.pending}` : ''}`
    + ` · 失败 ${s.failed}`);
  if (s.busy) console.log('注意      遇忙跳过说明这次没签成；当天一直遇忙就是漏签，不是"已完成"');
  if (s.circuit) console.log('注意      出现过熔断：连续失败到自动停工。修好后手动跑一次即可恢复');
  if (s.lastOk) console.log(`最近成功  ${new Date(s.lastOk).toLocaleString('zh-CN')}`);
  if (s.lastFail) console.log(`最近失败  ${new Date(s.lastFail).toLocaleString('zh-CN')}`);
}

/**
 * 修复客户端 —— 把 2026-10-31 那次手工急救固化成一条命令。
 *
 * 那次的处理是三步：结束全部进程 → 清 GPU 缓存 → 重新启动。事后复盘时
 * **无法确定是哪一步起效**（三步串行、没做对照实验），所以一开始做成了两级：
 * `--repair` 只重启，加 `--clear-cache` 才清缓存。
 *
 * 后来确认清缓存本身没有风险（三个目录全是可再生的着色器缓存，不含任何用户数据，
 * 删了客户端会自己重建），就没必要让用户选择 —— 默认三步全做，`--clear-cache`
 * 这个开关随之删除。少一个参数就少一次"我该选哪个"的犹豫。
 *
 * 三条底线：
 *   1. **只手动调用**。不带 --quiet 才生效，绝不进 plist，不被熔断或定时任务触发。
 *      （在文件顶部就拦了，见调用处。）
 *   2. **不碰输入法**。按 `/Applications/Doubao.app/` 路径匹配进程，
 *      豆包输入法在 `/Library/Input Methods/`，天然排除。
 *   3. **不碰会话数据**。只清 GPU/着色器缓存 —— 聊天记录、登录态、IndexedDB
 *      全都不在那三个目录里，也不会被碰。
 *
 * 还有一条是态度问题：**脚本不宣布"修好了"**。进程起来了不等于界面能用，
 * 那只有用户点一下会话才知道。所以最后一句是让他自己确认。
 */
async function runRepair() {
  const before = healthSnapshot();
  const cacheCount = before.caches.filter((c) => c.exists).length;

  sayLine('修复', '客户端疑似异常，准备按以下步骤处理');
  sub(before.running
    ? `结束全部 ${before.totalPids} 个豆包进程（不碰豆包输入法）`
    : '客户端当前未运行，跳过结束进程这一步');
  sub(`清理 ${cacheCount} 个 GPU 缓存目录（先备份；只清可再生的着色器缓存）`);
  sub('然后重新启动客户端');

  if (!FLAG.yes) {
    const ok = await confirm('\n继续？输入 y 回车继续，其他键取消：');
    say('');   // 管道输入时用户按的回车到不了终端，这里补一个换行，别让下一行粘在问句后面
    if (!ok) {
      sayLine('结果', '已取消，什么都没做');
      process.exit(EXIT.OK);
    }
  }

  sayLine('修复前', `进程 ${before.totalPids} 个 · 缓存 ${humanBytes(before.cacheBytes)}`
    + ` · exit_type=${before.exitType ?? '?'}`);
  hr();

  sayLine('结束进程', before.running ? '发送 SIGTERM，最多等 5 秒…' : '无需操作');
  const stopped = await stopAllClient();
  if (stopped.how === 'not-running') sub('客户端本来就没在跑');
  else if (stopped.how === 'term') sub(`${stopped.before} 个进程已全部退出`);
  else sub(`${stopped.before} 个进程已退出，其中 ${stopped.killed} 个需要 SIGKILL`);

  const stamp = stampOf(new Date()).replace(/[- :]/g, '');
  const destRoot = join(BACKUP_DIR, `repair-${stamp}`);
  sayLine('清缓存', `备份到 ${destRoot}`);
  for (const r of backupAndClearCaches(destRoot)) {
    const name = r.rel.split('/').pop();
    if (r.skipped) sub(`${name}：不存在，跳过`);
    else if (r.error) subWarn(`${name}：${r.error}`);
    else sub(`${name}：${humanBytes(r.bytes)} · ${r.files} 个文件，已备份并清空`);
  }
  pruneRepairBackups();

  sayLine('启动', '重新打开客户端…');
  spawn('open', ['-a', APP.app], { detached: true, stdio: 'ignore' }).unref();

  // 等到"进程确实起来了"再收工：3 个是个宽松下限（主进程 + GPU + 一个渲染进程），
  // 等到了再给 3 秒让窗口画出来。等不到也不报错 —— 冷启动慢的时候很常见。
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (allClientPids().length >= 3) break;
    await sleep(500);
  }
  await sleep(3000);

  const after = healthSnapshot();
  hr();
  sayLine('修复后', `进程 ${after.totalPids} 个 · 缓存 ${humanBytes(after.cacheBytes)}`
    + ` · exit_type=${after.exitType ?? '?'}`);
  if (!after.totalPids) subWarn('客户端没有起来，请手动打开一次看看');
  else if (after.totalPids < 3) subWarn('进程数偏少，可能还没启动完');
  else sub('进程已就绪');

  // exit_type 修完仍是 Crashed 是正常的：它记的是"上一次怎么退出的"，
  // 而这次修复本身就是强制结束。不要把它当成修复失败。
  sayLine('请确认', '脚本只能保证进程已重启。界面是否恢复，请你点一下会话、发一条消息确认');

  const summary = `已修复：结束 ${stopped.before} 个进程、清理 GPU 缓存、`
    + `重新启动（现 ${after.totalPids} 个进程）`;
  appendHistory({
    at: new Date().toISOString(), date: todayKey(), result: 'REPAIR',
    duration_ms: Date.now() - startedAt, port: null, mode: 'reuse',
    client: clientVersion(), dry_run: false, needs_attention: false,
    report: summary,
    repair: { before_pids: before.totalPids, after_pids: after.totalPids, stop: stopped.how, cleared_cache: true },
  });
  writeRun(timeline, { duration_ms: Date.now() - startedAt });
  process.exit(EXIT.OK);
}

/**
 * 只保留最近 N 份 repair 备份（默认 3）。
 *
 * 一份备份 5~7MB，不清的话每修一次涨一份、永不回收。这些目录是本脚本自己建的，
 * 清理它们不算"动用户文件"。删失败也无所谓 —— 多留几份不影响任何正确性。
 */
function pruneRepairBackups(keep = 3) {
  try {
    const dirs = readdirSync(BACKUP_DIR)
      .filter((n) => /^repair-\d{14}$/.test(n))
      .sort()
      .reverse();
    for (const n of dirs.slice(keep)) {
      rmSync(join(BACKUP_DIR, n), { recursive: true, force: true });
    }
  } catch { /* 目录还不存在、或删除失败，都不影响修复 */ }
}

async function main() {
  if (argv.has('--help') || argv.has('-h')) {
    console.log(HELP);
    process.exit(EXIT.OK);
  }

  // 只输出版本号本身（不带工具名、不带 v 前缀），这样 `$(… --version)` 能直接比较
  if (FLAG.version) {
    console.log(toolVersion());
    process.exit(EXIT.OK);
  }

  if (FLAG.createConfig) {
    const r = createConf();
    if (r.ok) {
      console.log(`已生成配置：${r.path}`);
      console.log('（内容来自代码内置的模板，带完整注释；改完立即生效，不用重装定时任务）');
    } else if (r.existed) {
      console.log(`已存在，没有覆盖：${r.path}`);
      console.log('（想恢复默认值：先删掉这个文件，再执行本命令）');
    } else {
      console.error(`生成失败：${r.reason}`);
      process.exit(EXIT.FAIL);
    }
    process.exit(EXIT.OK);
  }

  if (FLAG.log) {
    showLog(FLAG.logCount);
    process.exit(EXIT.OK);
  }

  // 首次运行：没有 config.conf 就用**代码内置的模板**生成一份（不读磁盘上的
  // config.conf.template —— 那个文件可能已经被改名成 config.conf 或被删掉）。
  // 之前的做法是"没有就用内置默认值、什么都不生成"，结果是用户改不了任何东西
  // （连改哪个文件都不知道）。生成失败也不影响签到，绝不能因此中断。
  if (!existsSync(CONFIG_PATH)) {
    const r = createConf();
    if (!FLAG.quiet && !FLAG.json) {
      if (r.ok) {
        sayLine('配置', `首次运行，已生成 ${CONFIG_PATH}`);
        sub('想改端口 / 是否重启豆包 / 忙闲阈值就编辑它，改完立即生效');
      } else {
        subWarn(`没能生成 config.conf（${r.reason}），本次按默认值继续`);
      }
    }
  }

  // 单实例锁：launchd 的两套触发机制会重叠，叠跑会导致双方互相 pkill
  if (!FLAG.doctor) {
    const lock = acquireLock();
    if (!lock.ok) {
      const msg = lock.holder
        ? `另一个实例正在运行（pid ${lock.holder}），本次跳过`
        : '另一个实例正在启动，本次跳过';
      if (FLAG.json) console.log(JSON.stringify({ ok: true, result: 'SKIPPED', report: msg, needs_attention: false }));
      else if (!FLAG.quiet) console.log(msg);
      process.exit(EXIT.OK);
    }
  }

  // 今天已经确认签过 → 连客户端都不用碰。
  // 这一条让"每小时兜底"不再变成"每小时重启一次豆包"。
  //
  // 判据直接从 history.jsonl 的最后一条读，不再单独维护一个 .last-result.json ——
  // 两份文件记同一件事，迟早会不一致。
  if (!FLAG.dryRun && !FLAG.doctor && !FLAG.ignoreHistory) {
    // 不能只看最后一条：SKIPPED 记录会把 SUCCESS/ALREADY 挤到后面，
    // 只看最后一条会导致"跳过"之后下一次又完整执行（缓存形同虚设）。
    const recent = readHistory(30);
    const signedToday = recent.find(
      (r) => r.date === todayKey() && (r.result === 'SUCCESS' || r.result === 'ALREADY')
    );
    if (signedToday) {
      // 结果只能是 SKIPPED：这一次真的什么都没做，连客户端都没碰。
      // ALREADY 的含义是"读了页面，页面说今天已签"——两条不同的路径，不能混用。
      // 所以这里既不把 result 写成 ALREADY，也不在文案里带内部结果名。
      const when = stampOf(new Date(signedToday.at));
      const msg = `历史记录显示今日已签到（${when}），本次跳过。`;
      appendHistory({
        at: new Date().toISOString(), date: todayKey(), result: 'SKIPPED',
        duration_ms: 0, port: null, mode: null, client: clientVersion(),
        report: msg, needs_attention: false,
        reason: 'CACHED', cached_from: signedToday.result,
      });
      if (FLAG.json) console.log(JSON.stringify({ ok: true, result: 'SKIPPED', report: msg, needs_attention: false }));
      else if (!FLAG.quiet) console.log(msg);
      process.exit(EXIT.OK);
    }
  }

  const report = {
    ok: false, result: 'FAIL', report: '', needs_attention: false,
    at: new Date().toISOString(), dry_run: FLAG.dryRun,
  };

  const now = new Date();
  const stamp = stampOf(now);
  say(`${APP_TITLE}  ·  ${stamp}`);
  hr();

  const client = discover();
  report.client = client;
  sayLine('客户端', `${client.version} · Chromium ${client.chromium || '未知'} · ${client.bundleId}`);

  // 读配置：命令行 > config.conf > 内置默认
  const loaded = await loadSettings({
    allowRelaunch: FLAG.allowRelaunchGiven ? true : undefined,
  });
  PREFS = loaded.prefs;
  for (const w of loaded.warnings) sayLine('配置', w);

  // 配置里的路径生效
  if (PREFS.appPath) APP.app = PREFS.appPath;
  if (PREFS.logDir) setLogDir(PREFS.logDir);

  // 版本变了就说一句。豆包的自动更新是静默的（2026-10-31 从 2.33.5 升到 2.34.6
  // 就没任何提示），而选择器跟版本耦合 —— 提前告诉用户，比等失败弹窗好。
  //
  // ⚠️ 必须放在 setLogDir() **之后**：readHistory() 走 logDir()，放前面会读默认
  // 目录。第一版就写错了位置，用临时 logDir 测出来提示不出现。
  const prevVersion = lastRecordedVersion();
  if (prevVersion && client.version && client.version !== 'unknown' && prevVersion !== client.version) {
    subWarn(`上次记录的是 ${prevVersion} —— 客户端已升级，签到选择器可能需要复核（可先跑 --dry-run）`);
    report.version_change = { from: prevVersion, to: client.version };
  }

  if (FLAG.verbose) {
    sayLine('配置', `allowRelaunch=${PREFS.allowRelaunch} · busyCheck=${PREFS.busyCheck.enabled ? '开' : '关'}`);
  }

  if (!client.hasHelper) {
    sayLine('警告', '未发现 Helpers/Doubao Browser.app，CDP 可能不可用');
  }

  if (FLAG.doctor) {
    const snap = healthSnapshot();
    const running = snap.running;
    sayLine('进程', running
      ? `运行中（pid ${snap.mainPid ?? '?'}）· 共 ${snap.totalPids} 个进程`
      : '未运行');
    sayHealth(snap);
    if (report.version_change) {
      sayLine('版本变化', `上次 ${report.version_change.from} → 本次 ${report.version_change.to}`
        + '（选择器可能需要复核，先跑 --dry-run）');
    }

    if (running) {
      const { port, ports } = await findDoubaoCdpPort();
      sayLine('监听端口', ports.length ? ports.join(' ') : '（无）');
      sayLine('CDP', port ? `已开启 → ${port}` : '未开启');
      if (port) {
        runtime.port = port;
        const ts = await listTargets();
        sayLine('Target', `${ts.length} 个`);
        for (const t of ts.slice(0, 8)) say(`          ${t.type}  ${(t.url || '').slice(0, 60)}`);
      }
    }

    const conflicts = portConflicts(PREFS?.cdpPort ?? APP.port, 10);
    if (conflicts.length) {
      sayLine('端口占用', `${PREFS?.cdpPort ?? APP.port}~${(PREFS?.cdpPort ?? APP.port) + 9} 范围内：`);
      for (const c of conflicts) say(`          ${c.port} ← ${c.command}（pid ${c.pid}）`);
    } else {
      sayLine('端口占用', `${PREFS?.cdpPort ?? APP.port}~${(PREFS?.cdpPort ?? APP.port) + 9} 全部空闲`);
    }
    const next = await pickFreePort(PREFS?.cdpPort ?? APP.port, APP.portScanRange);
    sayLine('下一个可用', next ?? '（无）');

    // 症状归纳：把 2026-10-31 那次真正能看出问题的几个信号凑成一句人话。
    // 单独一个 Crashed 不算什么（被强杀过一次就会有），所以要求至少两项同时可疑。
    const suspects = [];
    if (snap.exitType === 'Crashed') suspects.push('上次异常退出');
    const stale = snap.caches.filter((c) => c.exists && c.ageHours !== null && c.ageHours > 24);
    if (snap.caches.length && stale.length === snap.caches.length) suspects.push('GPU 缓存 24 小时没写入');
    if (running && snap.totalPids < 10) suspects.push(`进程只有 ${snap.totalPids} 个（正常约 15 个）`);
    if (running && suspects.length >= 2) {
      sayLine('建议', `${suspects.join('；')} → 可试 ./scripts/doubao-checkin.sh --repair`);
    }

    report.ok = true;
    report.result = 'DOCTOR';
    report.report = running
      ? (runtime.port ? `客户端运行中，CDP 已开启（端口 ${runtime.port}）` : '客户端运行中但未开 CDP；未运行的客户端可直接启动，已运行的普通客户端需要 allowRelaunch（config.conf）或 --allow-relaunch')
      : '客户端未运行（脚本可直接带端口启动，无需额外参数）';
    return finish(report);
  }

  // ── 修复模式 ──
  //
  // 放在 doctor 之后（诊断得能看）、熔断之前（修复不该被熔断拦住）。
  // --quiet（定时任务）在这里已经不可能出现：文件顶部就拦掉了。
  if (FLAG.repair) return runRepair();

  // ── 连续失败熔断 ──
  //
  // 放在这个位置的原因：loadSettings 之后（要用到配置）、doctor 之后（诊断不该被挡）、
  // 忙闲检查之前（这时连客户端都还没碰过）。
  //
  // 只在 --quiet 下生效 —— 那是 install-launchd.sh 写进 plist 的参数，等价于
  // "这一跑是定时任务发起的"。你在终端里手动跑不带它，永远放行：手动运行
  // 通常就是你在排查问题，正需要一次真实运行去验证。
  if (FLAG.quiet && !FLAG.dryRun && !FLAG.doctor && !FLAG.ignoreHistory) {
    const rows = readHistory(50);
    const st = breakerState(rows, {
      threshold: PREFS.breaker.threshold,
      cooldownHours: PREFS.breaker.cooldownHours,
    });

    if (st.tripped) {
      const whenText = st.retryAt ? stampOf(st.retryAt) : '稍后';
      const msg = `连续 ${st.fails} 次失败，已暂停自动重试`
        + `（${whenText} 后放行一次试探）。`
        + '修好客户端后手动跑一次即可恢复，也可以改 config.conf 的 breaker.threshold。';

      report.ok = true;
      report.result = 'CIRCUIT';
      report.needs_attention = false;
      report.report = msg;

      // 只在「第一次熔断」时弹窗：之后每次运行都弹，等于每小时骚扰一次，
      // 正好是熔断要消除的那件事。
      const firstTrip = !rows.some((r) => r.result === 'CIRCUIT');
      if (firstTrip && !FLAG.noNotify) notify(APP_TITLE, msg, { key: 'CIRCUIT', debounceMs: notifyDebounceMs() });

      return finish(report);
    }

    if (st.probe) sub(`连续失败 ${st.fails} 次，冷却已过 —— 本次放行一次试探`);
  }

  // 重启前的忙闲检查：只有"允许重启 + 客户端正在普通模式运行"时才需要。
  // 没启动 → 直接拉起，不打扰任何人；已带 CDP → 直接复用。这两种都不查。
  if (PREFS.allowRelaunch && PREFS.busyCheck.enabled && isRunning()) {
    const { port } = await findDoubaoCdpPort();
    if (!port) {
      const bc = PREFS.busyCheck;
      sayLine('检查', `豆包客户端已启动，脚本正在自动观察 ${bc.windowSeconds} 秒，判断客户端是否正在执行任务…`);
      const verdict = await probeBusy({
        windowSeconds: bc.windowSeconds,
        sampleSeconds: bc.sampleSeconds,
        cpuThreshold: bc.cpuThreshold,
        netInKBps: bc.netInKBps,
        onSample: (s, all) => {
          if (FLAG.verbose) sub(`${String(all.length).padStart(2)} 采样 · 进程 ${s.procs} 个`);
        },
      });
      const cpuText = verdict.cpuMedian === null ? 'N/A' : `${verdict.cpuMedian.toFixed(2)} 核`;
      const netText = verdict.netInMedian === null ? 'N/A' : `${(verdict.netInMedian / 1024).toFixed(1)}KB/s`;

      if (!verdict.evaluable) {
        // 采不到数据时**按忙处理**：宁可多等一轮，也不要盲着重启
        subWarn('采不到 CPU/网络数据，无法判断忙闲 —— 按「忙」处理，本次跳过');
        report.result = 'BUSY';
        report.ok = true;
        report.report = '无法判断客户端是否在忙（采不到 CPU/网络数据），本次跳过。';
        return finish(report);
      } else if (verdict.busy) {
        // busyCheck.enabled=true 的语义就是"忙就跳过"，没有额外的"忙了怎么办"开关
        const msg = `客户端正在执行任务（${verdict.reasons.join('；')}），本次跳过。`;
        subWarn(`客户端正在执行任务（${verdict.reasons.join('；')}），本次跳过`);
        report.result = 'BUSY';
        report.ok = true;
        report.report = msg;
        report.needs_attention = false;
        report.busy = { cpuMedian: verdict.cpuMedian, netInMedian: verdict.netInMedian, reasons: verdict.reasons };
        return finish(report);
      } else {
        sub(`空闲（CPU 中位 ${cpuText} · 网入中位 ${netText}），可以安全重启`);
      }
    }
  }

  const ver = await resolveEndpoint();
  report.browser = ver?.Browser;
  report.port = runtime.port;
  report.client_mode = runtime.mode;
  const modeText = { reuse: '复用已开端口', restarted: '重启客户端', launched: '新启动客户端' }[runtime.mode] || runtime.mode;
  sayLine('端口', `${runtime.port} · ${ver?.Browser || '未知'} · ${modeText}`);

  sayLine('打开', '准备打开签到活动页…');
  const { target, created } = await openActivity();
  report.target = { id: target.id, created };

  // 等签到卡片真的出现。
  //
  // ⚠️ 不能拿「正文有没有字」当渲染完成的信号：SPA 的骨架屏/加载文案本身就有
  // 几十个字，实测会在第 7 秒就把一个完全正常的活动页判成 UNKNOWN。
  // 这里只认「卡片出现了」，或者「明确未登录」（那就不用等）。
  const waitStart = Date.now();
  let state = null;
  while (Date.now() - waitStart < APP.cardWaitMs) {
    state = await evaluate(target.webSocketDebuggerUrl, STATE_EXPR).catch(() => null);
    if (state?.found) break;
    if (state?.loginPrompt) break;
    if (remaining() < 25000) break;
    await sleep(700);
  }
  if (!state) throw fail('页面无响应', EXIT.FAIL);

  const waited = ((Date.now() - waitStart) / 1000).toFixed(1);
  const pg = state.page || {};
  // 成功时也说一句等了多久：边栏里的页面通常要 1~3 秒才渲染出内容，
  // 不说的话用户看到的就是"点完好几秒没动静"，会以为卡住了。
  if (state.found && Number(waited) >= 1) {
    sub(`活动页已渲染（等了 ${waited}s）`);
  }
  if (!state.found) {
    sub(`等待卡片 ${waited}s 未出现（readyState=${state.readyState || '?'}，正文 ${state.bodyLen || 0} 字）`);
    // 这行只在失败时打：正常运行时没有信息量，失败时这几个数字就是
    // 判断「网络没通」还是「前端崩了」的全部依据。
    sub(`页面画像 html ${pg.htmlLen ?? '?'} 字符 · 资源 ${pg.resTotal ?? '?'} 个`
      + `（未收到响应 ${pg.resPending ?? '?'}）· 在线 ${pg.online === false ? '否' : '是'} · ${pg.visibility || '?'}`);
  }

  const before = judge(state, APP);
  report.before = { verdict: before, cardText: state.cardText, buttonText: state.buttonText };
  // 轻量画像每次都记：没有「正常时长什么样」这个基线，失败时的数字就没法解读。
  // 只采失败样本的路子试过就知道不行 —— 一堆异常值，不知道哪个才算异常。
  if (state.page) report.page = state.page;
  sayLine('页面', state.url);
  sayLine('状态', `${before}${state.cardText ? `  「${state.cardText}」` : ''}`);

  if (before === 'DONE') {
    report.ok = true;
    report.result = 'ALREADY';
    report.report = '活动页面显示今日已签到，无需重复签到。';
    return finish(report, target, created);
  }

  if (before === 'AUTH_FAIL') {
    report.result = 'AUTH_FAIL';
    report.needs_attention = true;
    report.report = '未登录：请在豆包客户端里登录后重试';
    return finish(report, target, created);
  }

  if (before === 'UNKNOWN') {
    report.result = 'UNKNOWN';
    report.needs_attention = true;
    // 版本刚变过就别再猜"活动下线"了 —— 直接指向最可能的原因。
    // 否则用户会去翻活动页，白费半小时。
    const guess = report.version_change
      ? `。客户端刚从 ${report.version_change.from} 升到 ${report.version_change.to}，`
        + '很可能是选择器失效（改 src/app-profile.mjs 的 cardSelector）'
      : '。活动可能已下线或页面改版';
    report.report = `等了 ${waited}s 仍找不到签到卡片`
      + `（data-reward-code：${(state.rewardCodes || []).join(',') || '无'}，`
      + `readyState=${state.readyState || '?'}，正文 ${state.bodyLen || 0} 字，`
      + `资源 ${pg.resTotal ?? '?'} 个/未响应 ${pg.resPending ?? '?'}）`
      + guess
      + '（页面概况见 --log 1）';
    return finish(report, target, created);
  }

  // PENDING
  if (FLAG.dryRun) {
    report.ok = true;
    report.result = 'PENDING';
    report.report = `dry-run：当前未签到，按钮「${state.buttonText}」可点，未执行`;
    return finish(report, target, created);
  }

  sayLine('动作', '点击「立即签到」…');
  const clicked = await evaluate(target.webSocketDebuggerUrl, CLICK_EXPR);
  report.click = clicked;
  if (!clicked.ok) {
    report.result = 'FAIL';
    report.needs_attention = true;
    report.report = `找不到可点击的签到按钮（${clicked.reason}）`;
    return finish(report, target, created);
  }

  // 等待状态收敛 —— 只认 DOM 变化，不认接口返回值
  let after = null;
  let afterState = null;
  const deadline = Date.now() + APP.settleMs;
  while (Date.now() < deadline) {
    await sleep(800);
    afterState = await evaluate(target.webSocketDebuggerUrl, STATE_EXPR).catch(() => null);
    if (!afterState) continue;
    after = judge(afterState, APP);
    if (after === 'DONE') break;
  }

  report.after = { verdict: after, cardText: afterState?.cardText, buttonText: afterState?.buttonText };
  sayLine('状态', `${after}${afterState?.cardText ? `  「${afterState.cardText}」` : ''}`);

  if (after === 'DONE') {
    report.ok = true;
    report.result = 'SUCCESS';
    report.report = `签到成功${afterState?.cardText ? `：${afterState.cardText}` : ''}`;
  } else {
    report.result = 'FAIL';
    report.needs_attention = true;
    report.report = `点击后 ${Math.round(APP.settleMs / 1000)} 秒内状态未收敛（仍为 ${after || '未知'}）。未重试点击，避免重复提交`;
  }
  return finish(report, target, created);
}

function attentionMessage(report) {
  switch (report.result) {
    case 'AUTH_FAIL':
      return '豆包登录态失效。请打开客户端重新登录，之后任务会自动恢复。';
    case 'UNKNOWN':
      return '找不到签到卡片，活动可能已下线或页面改版。\n页面概况见 --log 1，提 issue 时附上即可。';
    default:
      return report.report || '签到失败，请查看 logs/checkin.log';
  }
}

// ── 本地结果缓存 ──
// 目的：一天内确认签过之后，后续的每小时兜底不再去碰客户端。
// 这是"端口只在签到时临时开一下"的另一半 —— 少一次重启就少一次打扰。

// 统一的时间戳格式：YYYY-MM-DD HH:mm:ss。
// 之前每处各写一遍 padStart，结果缓存命中那句话只写了 HH:mm，还带个语义不明的「确认的」。
function stampOf(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function finish(report, target, created) {
  // 只关自己开的页面，别动用户的标签页
  if (created && target) {
    try { await fetch(`${base()}/json/close/${target.id}`, { signal: AbortSignal.timeout(3000) }); } catch { /* ignore */ }

    // 等它真的从 target 列表里消失再往下走。
    // JSON/close 是异步的：接口返回了不代表渲染进程已经退出。
    // 带着一个没关干净的页面去请求客户端退出，很可能就卡在那儿 ——
    // 手动测试时客户端能 2 秒退掉，而脚本里 30 秒都退不掉，差别就在这里。
    const deadline = Date.now() + 5000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        const ts = await listTargets();
        if (!ts.some((t) => t.id === target.id)) { gone = true; break; }
      } catch { gone = true; break; }
      await sleep(200);
    }
    if (!gone) say(`  ⚠ 页面 ${target.id.slice(0, 8)} 关闭后仍留在 target 列表里`);
    await sleep(500); // 给渲染进程一点收尾时间
  } else if (runtime.openedPanel) {
    // 我们用「点链接」让 App 开的边栏：收掉探针链接，并尽力关掉边栏
    try {
      const chat = await listTargets().then((ts) => ts.find((t) => t.id === runtime.openedPanel.pageTargetId));
      if (chat) {
        const r = await evaluate(chat.webSocketDebuggerUrl, `(() => {
          document.getElementById('__doubao_auto_signin_link__')?.remove();
          const aside = document.querySelector('aside');
          if (!aside) return JSON.stringify({ closed: false, reason: 'no aside' });
          const btn = [...aside.querySelectorAll('button, [role="button"]')]
            .find((b) => /关闭|close|收起/i.test((b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.className || '')));
          if (btn) {
            const r = btn.getBoundingClientRect();
            for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
              btn.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, view: window,
                clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
              }));
            }
            return JSON.stringify({ closed: true });
          }
          return JSON.stringify({ closed: false, reason: 'no close button found' });
        })()`).catch((e) => ({ closed: false, reason: e.message }));
        if (r?.closed) sub('已收起边栏'); else subWarn(`边栏未能收起（${r?.reason || '?'}），保持原样`);
      }
      await sleep(400);
    } catch { /* 清理失败不影响签到结果 */ }
  }

  // 还原客户端：端口只在需要时临时开一下
  try {
    await restoreClient();
  } catch (e) {
    report.restore_error = e.message;
    subWarn(`恢复客户端失败：${e.message}`);
  }

  hr();
  sayLine('结论', `[${report.result}] ${report.report}`);

  // 只在需要人介入时弹窗。成功不弹 —— 每天弹一次"成功"会让人很快关掉通知权限
  if (report.needs_attention && !FLAG.noNotify && !FLAG.dryRun) {
    notify(APP_TITLE, attentionMessage(report), { key: report.result, debounceMs: notifyDebounceMs() });
  }

  if (FLAG.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // 非 JSON 模式：额外打一行机器可解析的结果，方便日志 grep
    console.log(JSON.stringify({ result: report.result, report: report.report, needs_attention: report.needs_attention }));
  }

  // ── 落盘 ──
  // history.jsonl 每次都写（含空跑），用于 --log 统计
  // checkin.log 只在「真签到」或「出问题」时写，避免有价值记录被空跑淹没
  if (report.result !== 'DOCTOR') {
    const record = {
      at: new Date(startedAt).toISOString(),
      date: todayKey(),
      result: report.result,
      duration_ms: Date.now() - startedAt,
      port: report.port ?? runtime.port ?? null,
      mode: report.client_mode ?? runtime.mode,
      client: report.client?.version ?? clientVersion(),
      dry_run: !!report.dry_run,
      needs_attention: !!report.needs_attention,
      report: report.report,
    };
    // 判忙跳过的记录带上判定依据（CPU/网入中位 + 触发的原因）。
    // 不带的话，事后只剩一句"客户端正在执行任务"，分不清是真忙还是阈值太紧。
    if (report.busy) record.busy = report.busy;
    // 页面画像：几个数字而已，但它是判断"正常"长什么样的基线。
    // 没它的话，下次再出故障只能看到一堆异常值，不知道正常该是多少。
    if (report.page) record.page = report.page;
    // 版本变化也记一笔：事后翻 --log 时能直接看出"那天是不是刚升过级"
    if (report.version_change) record.version_change = report.version_change;
    appendHistory(record);

    // ALREADY 也要记：它虽然没签到，但真的动过客户端（重启了两次）。
    // 不记的话，出问题翻日志时会发现"那天明明跑过却什么都没留下"。
    // BUSY 更要记：那 30 秒的采样数据是调忙闲阈值的唯一依据。
    // 纯缓存跳过的是 SKIPPED，走不到这里。
    if (report.result === 'SUCCESS' || report.result === 'ALREADY'
      || report.result === 'BUSY' || report.needs_attention || FLAG.verbose) {
      writeRun(timeline, { duration_ms: record.duration_ms });
    }
  }

  // BUSY / SKIPPED / CIRCUIT 都是「这次没做、但没出错」，退出码必须是 0 ——
  // 否则 launchd 每次都会记一条 exit code 1，日志里分不清"跳过了"和"挂了"。
  const code = {
    SUCCESS: EXIT.OK, ALREADY: EXIT.OK, PENDING: EXIT.OK, DOCTOR: EXIT.OK,
    SKIPPED: EXIT.OK, BUSY: EXIT.OK, CIRCUIT: EXIT.OK, REPAIR: EXIT.OK,
    AUTH_FAIL: EXIT.AUTH, UNKNOWN: EXIT.UNKNOWN,
  }[report.result] ?? EXIT.FAIL;
  process.exit(code);
}

/**
 * 签到主流程。
 *
 * 由 bin/cli.mjs 调用（正常路径），直接 `node bin/checkin.mjs` 也仍然可用
 * —— 见文件末尾的判断。这样做是因为引入 cli 之后不能把老用法弄断：
 * 旧笔记、旧脚本、还有 install-launchd 早期版本生成的 plist 都可能指向这里。
 *
 * 注意：main() 的每个出口都会 process.exit，所以 run() 正常不会返回。
 */
export async function run() {
  return main().catch(async (e) => {
  const code = e.exitCode || EXIT.FAIL;
  const payload = { ok: false, result: code === EXIT.AUTH ? 'AUTH_FAIL' : code === EXIT.UNKNOWN ? 'UNKNOWN' : 'FAIL', report: e.message, needs_attention: true, dry_run: !!FLAG.dryRun };
  if (FLAG.json) console.log(JSON.stringify(payload, null, 2));
  else { console.error(`\n[失败] ${e.message}`); console.log(JSON.stringify(payload)); }

  // 抛错路径不会经过 finish()，也就不会还原客户端 —— 那会留下一个带调试端口
  // （无鉴权）的客户端一直开着，比少签一次严重得多。
  // restoreClient 自带白名单（只有 launched/restarted 才动手）且幂等，
  // 这里兜底调用是安全的；它自己的失败也不能掩盖原始错误。
  try { await restoreClient(); } catch { /* ignore */ }

  // ⚠️ 抛错路径也必须带 dry_run：少了它，一次 `--dry-run` 失败会被记成真实失败，
  // 混进 `--log` 统计、还会被下次 `--quiet` 运行算进熔断计数。
  appendHistory({
    at: new Date(startedAt).toISOString(), date: todayKey(), result: payload.result,
    duration_ms: Date.now() - startedAt, port: runtime.port ?? null, mode: runtime.mode ?? null,
    client: clientVersion(), dry_run: !!FLAG.dryRun, needs_attention: true, report: e.message,
  });
  writeRun(timeline, { duration_ms: Date.now() - startedAt });

    if (!FLAG.noNotify && !FLAG.dryRun) {
      notify(APP_TITLE, e.message, { key: `ERR:${code}`, debounceMs: notifyDebounceMs() });
    }
    process.exit(code);
  });
}

/**
 * 被直接执行（node bin/checkin.mjs）时才自己跑。
 * 被 cli.mjs import 时 process.argv[1] 是 cli.mjs，这个判断为假，不会重复执行。
 */
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) run();
