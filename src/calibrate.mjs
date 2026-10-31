/**
 * 忙闲阈值校准：交互式采样 → 推算建议阈值 → 可选写回 config.conf
 *
 * 和 src/busy.mjs 的分工（这是本次重构的核心，别再各写一份）：
 *   · busy.mjs       —— 运行时判定。采什么、怎么判，都以它为准
 *   · calibrate.mjs  —— 校准。**复用 busy.mjs 的采集**，只是采得更久、
 *                       多采几路信号（磁盘 / 输入空闲）用来判读，并把
 *                       推算出来的阈值写回配置
 *
 * 数据源必须和签到共用同一套：processTree / parseCpuTime / netBytes 统统从
 * busy.mjs 取。各留一份的话，改了一边忘了另一边，就会变成"校准用的数据源
 * 和签到实际用的数据源不是一回事"——这种偏差极难发现。
 *
 * 纯统计函数（cpuRates / windowsOf / deriveThresholds / tailThreshold /
 * autoTailCount / phaseStats）都显式接收 samples 参数、不读全局、不碰 IO，
 * 所以可以直接单测 —— 这些阈值推算公式是这个工具最需要被验证的部分。
 */

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { processTree, parseCpuTime, netBytes } from './busy.mjs';
import { CONFIG_PATH, readConfKey, upsertConfKey } from './settings.mjs';
import { logDir } from './log.mjs';

const execFileP = promisify(execFile);

// ──────────────────────────── 纯统计（可单测） ────────────────────────────

export const delta = (a, b, k) => (a?.[k] == null || b?.[k] == null ? null : Math.max(0, b[k] - a[k]));

/**
 * 一段样本的逐点 CPU 速率（秒/秒 = 占几个核）。
 * idx 是 samples 的绝对索引；速率用「当前样本 - 上一个样本」，所以第一点必然为 null。
 */
export function cpuRates(samples, idx) {
  return idx.map((i) => {
    const cur = samples[i]; const prev = samples[i - 1];
    if (!prev || cur.cpu_s == null || prev.cpu_s == null) return null;
    const dt = Number(cur.t) - Number(prev.t);
    return dt > 0 ? (cur.cpu_s - prev.cpu_s) / dt : null;
  });
}

const idleIdx = (samples) => samples.map((s, i) => (s.phase === 'idle' ? i : -1)).filter((i) => i >= 0);
const med = (arr) => {
  const v = arr.filter((x) => x !== null && x >= 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

/** 分位数（nearest-rank）。窗口数很少时它就是最大值，所以调用方要检查窗口数。 */
function quantile(values, q) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((v.length - 1) * q))];
}

/** 运行时 judgeWindow 一次判 10 个速率（30s / 3s）→ 校准必须用同样的窗口，否则两边不是一回事 */
export const WINDOW_RATES = 10;

/**
 * 把一个阶段切成「和运行时同样的窗口」：每 10 个速率取一次中位。
 *
 * 为什么必须这样：运行时判的是「30 秒窗口内的中位」，校准如果拿单点样本算 p90，
 * 算的根本不是同一个统计量，阈值当然对不上（0.06 那次就是这么来的）。
 * 速率不够 10 个时（阶段太短）退化为整段一个窗口，并置 short=true —— 调用方要知道这个数没有分布。
 */
export function windowsOf(samples, key) {
  const idx = samples.map((s, i) => (s.phase === key && !s.edge ? i : -1)).filter((i) => i >= 0);
  const rates = [];
  for (let k = 1; k < idx.length; k++) {
    const a = samples[idx[k - 1]]; const b = samples[idx[k]];
    const dt = Number(b.t) - Number(a.t);
    if (!(dt > 0) || a.cpu_s == null || b.cpu_s == null) continue;
    const net = (a.net_in == null || b.net_in == null) ? null : Math.max(0, b.net_in - a.net_in) / dt;
    rates.push({ cpu: (b.cpu_s - a.cpu_s) / dt, net });
  }
  const windows = [];
  if (rates.length >= WINDOW_RATES) {
    for (let i = 0; i + WINDOW_RATES <= rates.length; i++) {
      const sl = rates.slice(i, i + WINDOW_RATES);
      windows.push({ cpu: med(sl.map((x) => x.cpu)), net: med(sl.map((x) => x.net)) });
    }
  } else if (rates.length) {
    windows.push({ cpu: med(rates.map((x) => x.cpu)), net: med(rates.map((x) => x.net)) });
  }
  return { rates: rates.length, windows, short: rates.length > 0 && rates.length < WINDOW_RATES };
}

/**
 * 尾部检测专用的门槛 —— 和生产判定**不是一回事**，别共用。
 *
 * 生产判定要保守（低门槛，宁可多等）；尾部检测要能区分
 * "任务峰值"和"任务结束后的回落"，所以门槛必须落在两者之间。
 * 取 min( max(空闲中位 × 2, 本阶段峰值 × 0.4), 本阶段峰值 × 0.6 )：
 *   - 任务 0.83 / 回落 0.23 / 空闲中位 0.21 → 门槛 0.42，两边都分得开
 *   - 任务只比空闲高一点（峰值 0.28）→ 门槛被压到 0.17，回落也超门槛 → 判不出，不剔
 */
export function tailThreshold(samples, idx) {
  const rates = cpuRates(samples, idx).filter((v) => v !== null && v >= 0);
  if (!rates.length) return null;
  const peak = Math.max(...rates);
  const idleMed = med(cpuRates(samples, idleIdx(samples))) ?? 0;
  return Math.min(Math.max(idleMed * 2, peak * 0.4), peak * 0.6);
}

/**
 * 智能判断尾部该剔几个样本。
 *
 * 固定剔 N 个是懒办法：任务恰好和用户及时回车时，尾部全是有效数据，白剔；
 * 用户离开久了，剔 2 个又不够。这里找"最后一个忙样本"：
 *   尾部连续 ≥2 个不忙 → 判定为任务结束后的回落，全部剔掉
 *   只有 1 个不忙      → 可能是任务内部的静默间隙（AI 任务常有），保留
 */
export function autoTailCount(samples, idx) {
  const T = tailThreshold(samples, idx);
  if (T === null) return 0;
  const busy = cpuRates(samples, idx).map((r) => (r === null ? false : r > T));
  let lastBusy = -1;
  for (let n = 0; n < busy.length; n++) if (busy[n]) lastBusy = n;
  if (lastBusy < 0) return 0;
  const trailing = busy.length - 1 - lastBusy;
  return trailing >= 2 ? trailing : 0;
}

/** 一个阶段的汇总。edge=1 的样本（首尾过渡）不计入。 */
export function phaseStats(samples, key) {
  const ss = samples.filter((s) => s.phase === key && !s.edge);
  if (ss.length < 2) return null;
  const span = Math.max(0.001, Number(ss.at(-1).t) - Number(ss[0].t));
  const disks = ss.map((s) => s.disk_bps).filter((v) => v !== null);
  const inputs = ss.map((s) => s.input_idle_s).filter((v) => v !== null);
  const per = (k) => { const d = delta(ss[0], ss.at(-1), k); return d === null ? null : d / span; };
  const idx = samples.map((s, i) => (s.phase === key ? i : -1)).filter((i) => i >= 0);
  const netInRates = idx.map((i) => {
    const cur = samples[i]; const prev = samples[i - 1];
    if (!prev || cur.net_in == null || prev.net_in == null) return null;
    const dt = Number(cur.t) - Number(prev.t);
    return dt > 0 ? (cur.net_in - prev.net_in) / dt : null;
  });
  // 逐样本速率的中位数：均值会被单个尖峰带偏（实测出现过 263K 的突发），中位数更稳
  return {
    n: ss.length, span,
    cpuPerSec: per('cpu_s'), cpuMed: med(cpuRates(samples, idx)),
    rssDelta: delta(ss[0], ss.at(-1), 'rss_kb'),
    netInPerSec: per('net_in'), netInMed: med(netInRates),
    netOutPerSec: per('net_out'),
    diskAvg: disks.length ? disks.reduce((a, b) => a + b, 0) / disks.length : null,
    diskMax: disks.length ? Math.max(...disks) : null,
    inputMin: inputs.length ? Math.min(...inputs) : null,
    procsMax: Math.max(...ss.map((s) => s.procs)),
  };
}

/**
 * 由本次采样推算建议阈值。
 *
 * 判据（全部用「窗口内中位」这个运行时同款统计量）：
 *   闲 = 本机见过的最坏空闲   idleRef = max(本次空闲窗口 p90, 历史各轮空闲窗口中位的最大值)
 *   忙 = 本次真正忙起来的下沿 busyP05 = min(对话窗口 p05, 任务窗口 p05)
 *   门槛 = √(idleRef × busyP05)，再夹到 [idleRef×1.1, busyP05×0.85]
 *
 * 为什么取几何中点：对「误判为忙」和「误判为闲」等距。单边打折（例如 p90×0.8）
 * 会让门槛低于空闲基线自己的最坏值——校准时就已经有样本会被判忙了。
 *
 * 为什么要掺历史空闲：同一台机器不同时段空闲能差 7 倍（实测 0.04 ~ 0.29 核，
 * 窗口被遮挡时渲染进程降频）。只看本次就会得出一个在下一天"天天判忙"的门槛，
 * 而判忙 = 静默漏签（`BUSY` 不弹窗），比多等一轮贵得多。
 *
 * 为什么回落段不当约束：回落水平比空闲还飘（实测 0.08 ~ 0.45 核，有一轮甚至低于当时空闲），
 * 拿它当上界会把门槛压到噪声里去。只作为参考值打印出来。
 *
 * @param {object[]} samples
 * @param {{historyIdle?: number[]}} [opts] historyIdle：历史各轮的空闲窗口中位（核）
 */
export function deriveThresholds(samples, { historyIdle = [] } = {}) {
  const idle = windowsOf(samples, 'idle');
  const chat = windowsOf(samples, 'chat');
  const task = windowsOf(samples, 'task');
  const fallback = windowsOf(samples, 'task_fallback');

  if (!idle.windows.length) return { ok: false, reason: '空闲阶段没有可用样本（采样不足 2 个点，或 CPU 数据采不到）' };
  const busyWins = [...chat.windows, ...task.windows].map((w) => w.cpu).filter((v) => v != null);
  if (!busyWins.length) return { ok: false, reason: '对话/任务阶段没有可用样本，定不出上界' };

  const idleP90 = quantile(idle.windows.map((w) => w.cpu), 0.9);
  const histValid = historyIdle.filter((v) => Number.isFinite(v) && v > 0 && v < 2);
  const historicalIdle = histValid.length ? Math.max(...histValid) : null;
  // 0.02 是防 0 的下限：cpu_s 一个采样周期都没涨时窗口会是 0，除以它会得出"什么都算忙"
  const idleRef = Math.max(idleP90, historicalIdle ?? 0, 0.02);

  const busyP05 = quantile(busyWins, 0.05);
  const separation = idleRef > 0 ? busyP05 / idleRef : Infinity;
  if (!(busyP05 > idleRef * 1.15)) {
    return {
      ok: false,
      reason: `空闲 ${idleRef.toFixed(2)} 核 与 忙碌 ${busyP05.toFixed(2)} 核 分不开（${separation.toFixed(1)} 倍）`,
      idleP90, historicalIdle, idleRef, busyP05, separation,
    };
  }

  const lo = idleRef * 1.1;
  const hi = busyP05 * 0.9;
  if (lo > hi) {
    return {
      ok: false,
      reason: `空闲最坏 ${idleRef.toFixed(2)} 核 与 忙碌下沿 ${busyP05.toFixed(2)} 核 只差 ${separation.toFixed(1)} 倍，夹不出可信门槛`,
      idleP90, historicalIdle, idleRef, busyP05, separation,
    };
  }
  const raw = Math.sqrt(idleRef * busyP05);
  const cpu = Math.round(Math.min(Math.max(raw, lo), hi) * 100) / 100;

  // 网入只当兜底：回落段的网入几乎等于空闲（实测 0.5 vs 0.3 KB/s），它分不出回落，
  // 所以只在 CPU 判不出来时补一刀，门槛取下限 1 KB/s。
  const idleNetP90 = quantile(idle.windows.map((w) => w.net), 0.9) ?? 0;
  const netKB = Math.max(1, Math.round((idleNetP90 / 1024) * 2 * 10) / 10);

  // 回落参考：任务刚结束时指标还没掉回空闲，门槛若高过它，那半分钟会被判"闲"
  const fallbackCpu = fallback.windows.length
    ? med(fallback.windows.slice(0, 3).map((w) => w.cpu)) : null;

  return {
    ok: true, cpu, netKB, raw, lo, hi,
    idleP90, historicalIdle, idleRef, busyP05, separation, fallbackCpu,
    wins: { idle: idle.windows.length, chat: chat.windows.length, task: task.windows.length, fallback: fallback.windows.length },
    short: idle.short,
  };
}

// ──────────────────────────── 输出格式 ────────────────────────────

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const LABELS = {
  idle: '空闲基线', chat: '纯对话', chat_fallback: '对话回落',
  task: '任务执行', task_fallback: '任务回落', wait: '等待',
};

// ──────────────────────────── 采样 ────────────────────────────

async function sh(cmd, argv, timeout = 10000) {
  try { const { stdout } = await execFileP(cmd, argv, { timeout, encoding: 'utf8' }); return stdout; }
  catch { return null; }
}

function parseSize(s) {
  if (!s) return null;
  const m = s.trim().replace(/\/s$/i, '').match(/^([\d.]+)\s*([KMGT]?)B?$/i);
  if (!m) return null;
  const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

/**
 * 进程树，带 4 秒缓存。
 *
 * 缓存放在这里而不是 busy.mjs：签到每次只探一次，加了缓存反而可能拿到
 * 客户端刚重启前的旧 pid（那会让 cpu 采样变 null）。校准每 3 秒采一次，
 * 每次一个 ps 没必要。
 */
let treeCache = { at: 0, pids: [] };
async function treePids(force = false) {
  if (!force && Date.now() - treeCache.at < 4000) return treeCache.pids;
  const t = await processTree();
  treeCache = { at: Date.now(), pids: t.pids };
  return t.pids;
}

async function cpuRss(pids) {
  if (!pids.length) return { cpu: null, rss: null };
  const out = await sh('ps', ['-o', 'cputime=,rss=', '-p', pids.join(',')]);
  if (!out) return { cpu: null, rss: null };
  let cpu = 0; let rss = 0; let ok = false;
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    const ct = parseCpuTime(f[0]); const rs = Number(f[1]);
    if (ct !== null) { cpu += ct; ok = true; }
    if (!Number.isNaN(rs)) rss += rs;
  }
  return ok ? { cpu, rss } : { cpu: null, rss: null };
}

/** 磁盘：busy.mjs 已放弃（macOS 上基本读不到），这里仍采一份只为判读时多一路信号 */
async function diskBytes() {
  const out = await sh('top', ['-l', '1', '-stats', 'pid,disk', '-n', '80']);
  if (!out) return null;
  let total = 0; let seen = false;
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 2 || !/^\d+$/.test(f[0])) continue;
    const v = parseSize(f.slice(1).join(' '));
    if (v !== null) { total += v; seen = true; }
  }
  return seen ? total : null;
}

/** 距离上次键鼠输入多少秒 —— 判读"豆包在忙"时用来排除"人也在忙"的干扰 */
async function inputIdleSecs() {
  const out = await sh('ioreg', ['-c', 'IOHIDSystem']);
  if (!out) return null;
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return m ? Number(m[1]) / 1e9 : null;
}

// ──────────────────────────── 一次校准的运行时状态 ────────────────────────────
// 模块级是因为 takeSample 由 setInterval 调用，不方便逐层传参。
// run() 开头会整体重置，所以重复调用不会串。

let samples = [];
let t0 = Date.now();
let dataStatus = {};
let phase = 'wait';
let capturing = false;
let cfg = { interval: 3000, idleSecs: 30, fallbackSecs: 30, out: '' };

function resetState(outPath) {
  samples = [];
  t0 = Date.now();
  dataStatus = { tree: false, cpu: false, rss: false, disk: false, net: false, input: false };
  phase = 'wait';
  capturing = false;
  treeCache = { at: 0, pids: [] };
  queued.length = 0;
  cfg.out = outPath;
}

async function takeSample() {
  const pids = await treePids();
  const [cr, net, disk, input] = await Promise.all([cpuRss(pids), netBytes(), diskBytes(), inputIdleSecs()]);
  if (pids.length) dataStatus.tree = true;
  if (cr.cpu !== null) dataStatus.cpu = true;
  if (cr.rss !== null) dataStatus.rss = true;
  if (net) dataStatus.net = true;
  if (disk !== null) dataStatus.disk = true;
  if (input !== null) dataStatus.input = true;

  const prev = samples.at(-1);
  const dt = prev ? Math.max(0.001, (Date.now() - t0) / 1000 - Number(prev.t)) : null;

  const s = {
    t: ((Date.now() - t0) / 1000).toFixed(1), wall: new Date().toISOString(), phase, edge: 0,
    procs: pids.length,
    cpu_s: cr.cpu, rss_kb: cr.rss,
    disk_bps: disk, net_in: net?.i ?? null, net_out: net?.o ?? null, input_idle_s: input,
  };
  samples.push(s);

  // 实时打一行：用户能直接看出任务什么时候真正结束，
  // 不用等事后翻 csv —— 实测有人就是因此错过了按回车的时刻。
  if (capturing) {
    const rate = (a, b) => (a != null && b != null ? (b - a) / dt : null);
    const cpuR = rate(prev?.cpu_s, s.cpu_s);
    const niR = rate(prev?.net_in, s.net_in);
    const noR = rate(prev?.net_out, s.net_out);
    const kb = (v) => (v === null ? 'N/A'
      : (v < 0 ? 'reset' : `${v >= 1024 ? `${(v / 1024).toFixed(1)}K` : `${v.toFixed(0)}B`}`).padStart(7));
    console.log(c.dim(`    ${s.t.padStart(6)}s | CPU ${cpuR === null ? 'N/A'.padStart(5) : cpuR.toFixed(2).padStart(5)}/s`
      + ` | 网入 ${kb(niR)} | 网出 ${kb(noR)} | 进程 ${s.procs}`));
  }
}

// ──────────────────────────── 交互 ────────────────────────────

let rl = null;
let pending = null;          // 当前等待中的一行输入
let inputClosed = false;
const queued = [];           // 提前到达的输入（粘贴 / 连按回车）排队，不能丢

/**
 * 读一行。
 *
 * inputClosed 是必需的：管道喂输入 / `</dev/null` / Ctrl-D 时 stdin 会提前结束，
 * 那时再等就永远等不到，脚本静默挂死 —— 比报错退出更糟。
 *
 * 先查队列：readline 会把到达的行一次性全推过来，那时往往还没人等在 waitEnter 上。
 * 直接丢掉的话，粘贴进去的 Y/N 就失效了，用户只能再敲一次，还搞不清为什么没反应。
 */
function readLine() {
  if (queued.length) return Promise.resolve(queued.shift());
  if (inputClosed) {
    console.log(c.yellow('\n输入已结束，没法继续交互。'));
    console.log('这个脚本要在终端里直接跑：./scripts/doubao-checkin.sh --calibrate');
    process.exit(1);
  }
  return new Promise((res) => { pending = res; });
}

async function waitEnter(hint) {
  if (hint) console.log(hint);
  await readLine();
}

async function ask(q) {
  process.stdout.write(q);
  return readLine();
}

function markEdges(key, head = 0, tail = 0) {
  const idx = samples.map((s, i) => (s.phase === key ? i : -1)).filter((i) => i >= 0);
  if (tail === 'auto') {
    tail = autoTailCount(samples, idx);
    if (tail > 0) {
      const t = tailThreshold(samples, idx);
      console.log(c.dim(`  尾部自动剔除 ${tail} 个样本（检测到 CPU 跃降，区分门槛 ${t === null ? '?' : `${t.toFixed(2)}/s`}）`));
    }
  }
  for (const [n, i] of idx.entries()) {
    if (n < head) samples[i].edge = 1;
    if (n >= idx.length - tail) samples[i].edge = 1;
  }
  return tail;
}

async function runPhase(key, { fixed = 0, interactive = false, hint = '', note = '', quiet = '' } = {}) {
  console.log(`\n${c.bold(`【${LABELS[key]}】`)}${hint ? ` ${hint}` : ''}`);
  if (note) console.log(c.dim(`  ${note}`));

  if (fixed > 0) {
    phase = key; capturing = true;
    if (quiet) console.log(c.yellow(`  ${fixed} 秒 · ${quiet}`));
    await new Promise((r) => setTimeout(r, fixed * 1000));
    endPhase();
    markEdges(key, 1, 0);           // 开头可能还拖着上一个阶段的尾巴
    return;
  }

  if (interactive) {
    // 起始不剔样本：提示词要求"先把豆包跑起来、再立刻回车"，第一个样本必然是活动状态。
    // 只有尾部需要智能判断（用户可能没能及时回车）。
    console.log(c.yellow('  第一步：在豆包里让它开始跑（看到它开始输出）'));
    console.log(c.yellow('  第二步：立刻回到终端按回车，开始捕获（顺序不能错）'));
    await waitEnter();
    phase = key; capturing = true;
    console.log(`  开始捕获 ${stamp()}`);
    console.log(c.yellow('  ⚠️ 捕获中请一直盯着豆包，不要离开！'));
    // 结束时机完全由用户决定。下面那些数值只是"拿不准时"的参考，
    // 脚本不会自动停 —— 文案里不能出现「判断跑完的信号」这类说法，
    // 那会被读成"脚本会自己判结束"。
    console.log(c.yellow('  看到它跑完后，由你按回车结束捕获 —— 脚本不会自己停，也不会替你判断什么时候结束'));
    console.log(c.dim('  拿不准的话：CPU 掉到 0.3/s 以下、网入掉到 0.5K/s 以下，连续两个采样都这样，通常就是跑完了'));
    await waitEnter();
    endPhase();
    console.log(`  结束捕获 ${stamp()}`);
    markEdges(key, 0, 'auto');
  }
}

/** 阶段结束：把标签切回 wait，否则"等你按下一次回车"那段会被算进上一个阶段 */
function endPhase() {
  capturing = false;
  if (phase !== 'wait') phase = 'wait';
}

// ──────────────────────────── 报告 ────────────────────────────

const KEYS = ['idle', 'chat', 'chat_fallback', 'task', 'task_fallback'];

function printTable(stats) {
  const edgeCount = (k) => samples.filter((s) => s.phase === k && s.edge).length;

  console.log(c.bold(`\n${'─'.repeat(76)}`));
  console.log(c.bold('对比表'));
  console.log(c.dim('  交互阶段：起始不剔（提示词保证已跑起来），尾部按 CPU 跃变智能剔除'));
  console.log(c.dim('  固定阶段：剔除第 1 个样本（可能还拖着上个阶段的尾巴）'));
  console.log('─'.repeat(76));
  console.log(`  ${''.padEnd(16)}${KEYS.map((k) => LABELS[k].padStart(11)).join('')}`);
  console.log(`  ${''.padEnd(16)}${KEYS.map((k) => {
    const s = stats[k]; return (s ? `(${s.span.toFixed(0)}秒/${s.n})` : '(无)').padStart(11);
  }).join('')}`);
  const row = (label, key, unit, scale = 1024, digits = 1) => {
    const cell = (s) => (s && s[key] !== null && s[key] !== undefined
      ? `${(Math.abs(s[key]) / scale).toFixed(digits)}${unit}`.padStart(11) : 'N/A'.padStart(11));
    console.log(`  ${label.padEnd(16)}${KEYS.map((k) => cell(stats[k])).join('')}`);
  };
  // CPU 单位是"核"（占几个 CPU 核心），不是秒。写成 s 会被当成时间，也看不出量级。
  row('CPU 均值', 'cpuPerSec', ' 核', 1, 2);
  row('CPU 中位', 'cpuMed', ' 核', 1, 2);
  row('内存变化/MB', 'rssDelta', '', 1024);
  row('网络流入均值', 'netInPerSec', '/s');
  row('网络流入中位', 'netInMed', '/s');
  row('网络流出/秒', 'netOutPerSec', '/s');
  row('磁盘均值', 'diskAvg', '/s');
  row('磁盘峰值', 'diskMax', '/s');
  console.log(`  ${'输入空闲最小'.padEnd(16)}${KEYS.map((k) => {
    const v = stats[k]?.inputMin; return (v === null || v === undefined ? 'N/A' : `${v.toFixed(0)}秒`).padStart(11);
  }).join('')}`);
  console.log(`  ${'进程数峰值'.padEnd(16)}${KEYS.map((k) => String(stats[k]?.procsMax ?? 'N/A').padStart(11)).join('')}`);
  console.log(`  ${'边缘样本数'.padEnd(16)}${KEYS.map((k) => String(edgeCount(k)).padStart(11)).join('')}`);
}

/**
 * 判读：只讲三件事 —— 空闲到哪、忙到哪、门槛怎么落在这中间。
 * 不再列"相对空闲的倍数"那一堆：倍数好看不代表阈值可用（0.06 那次倍数最漂亮）。
 */
function printDerivation(d, stats) {
  console.log(c.bold('\n判读'));
  const base = stats.idle;
  if (!base) { console.log(c.red('  空闲基线样本不足')); return; }

  const ratio = (a, b) => (a && b && b > 0 ? `${(a / b).toFixed(1)} 倍` : 'N/A');
  for (const k of ['chat', 'task']) {
    const s = stats[k];
    if (!s) continue;
    console.log(`  ${LABELS[k].padEnd(5)} CPU 中位 ${ratio(s.cpuMed, base.cpuMed).padStart(8)}   `
      + `网入中位 ${ratio(s.netInMed, base.netInMed).padStart(8)}   `
      + `进程 +${(s.procsMax - base.procsMax) || 0}`);
  }

  if (!d?.ok) {
    console.log(c.red(`\n  给不出建议值：${d?.reason || '样本不足'}`));
    console.log(c.dim('  先按现有阈值跑；想要能用的结果，空闲/回落阶段各采满 60 秒，对话和任务都跑够半分钟。'));
    return;
  }

  const hist = d.historicalIdle === null ? '（没有历史数据）' : `${d.historicalIdle.toFixed(2)} 核`;
  const winSec = (cfg.interval / 1000) * WINDOW_RATES;
  console.log(c.bold('\n门槛推导'));
  console.log(`  空闲本轮到  ${d.idleP90.toFixed(2)} 核（${d.wins.idle} 个 ${winSec.toFixed(0)} 秒窗口的 p90）`);
  console.log(`  空闲历史到  ${hist} ← 跨轮次取最高，本机空闲能差好几倍，门槛不能被一轮的低值带跑`);
  console.log(`  忙碌下沿    ${d.busyP05.toFixed(2)} 核（对话 ${d.wins.chat} / 任务 ${d.wins.task} 个窗口的 p05）`);
  console.log(`  分离度      ${d.separation.toFixed(1)} 倍${d.separation < 2 ? c.yellow(' ← 偏低，两种状态靠得近') : ''}`);
  console.log(`  计算        √(${d.idleRef.toFixed(2)} × ${d.busyP05.toFixed(2)}) = ${d.raw.toFixed(2)}`
    + ` → 夹到 [${d.lo.toFixed(2)}, ${d.hi.toFixed(2)}] → ${c.bold(`${d.cpu} 核`)}`);
  console.log(`  网入        ${d.netKB} KB/s（只做兜底，回落段它分不出来）`);
  if (d.fallbackCpu !== null) {
    const fb = d.fallbackCpu;
    console.log(d.cpu > fb
      ? c.yellow(`  回落参考    ${fb.toFixed(2)} 核 —— 门槛比它高，任务刚结束那半分钟会被判"闲"`)
      : c.dim(`  回落参考    ${fb.toFixed(2)} 核 —— 门槛比它低，任务刚结束仍判"忙"（更保险）`));
  }
  if (d.wins.idle < 5) {
    console.log(c.yellow(`  注意        空闲只有 ${d.wins.idle} 个窗口，p90 退化成最大值了；按默认的 60 秒重测一次更稳`));
  }

  const signals = [];
  for (const k of ['chat', 'task']) {
    const s = stats[k];
    if (!s) continue;
    if (s.cpuMed && base.cpuMed && s.cpuMed > Math.max(base.cpuMed * 2.5, 0.05)) signals.push(`${LABELS[k]}:CPU`);
    if (s.netInMed && base.netInMed && s.netInMed > base.netInMed * 3) signals.push(`${LABELS[k]}:网络`);
    if (s.diskAvg && base.diskAvg && s.diskAvg > base.diskAvg * 3) signals.push(`${LABELS[k]}:磁盘`);
    if ((s.procsMax ?? 0) > (base.procsMax ?? 0)) signals.push(`${LABELS[k]}:进程数`);
  }
  console.log(signals.length
    ? `\n  ${c.green('显著变化的信号：')}${signals.join('  ')}`
    : `\n  ${c.red('没有任何信号显著变化 —— 这些指标分不出忙闲，需要换探测方式')}`);
}

function writeCsv() {
  mkdirSync(dirname(cfg.out), { recursive: true });
  writeFileSync(cfg.out, 't,wall,phase,edge,procs,cpu_s,rss_kb,disk_bps,net_in,net_out,input_idle_s\n'
    + `${samples.map((s) => [s.t, s.wall, s.phase, s.edge, s.procs, s.cpu_s, s.rss_kb,
      s.disk_bps, s.net_in, s.net_out, s.input_idle_s].join(',')).join('\n')}\n`);
  console.log(`\n原始数据：${cfg.out}`);
}

/**
 * 扫历史 CSV，取每一轮的空闲水平（该轮所有空闲窗口的中位）。
 * 目的只有一个：本机空闲能在这轮 0.04、那轮 0.29 之间漂 7 倍，
 * 只看本次算出来的门槛，换个时段就会天天判忙 —— 那是静默漏签。
 */
function historyIdleMedians(currentOut) {
  const dir = dirname(cfg.out);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.csv')); } catch { return []; }
  const vals = [];
  for (const n of names) {
    const p = join(dir, n);
    if (p === currentOut) continue;
    try {
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      if (lines.length < 2) continue;
      const head = lines[0].split(','); const i = (k) => head.indexOf(k);
      if (i('phase') < 0 || i('cpu_s') < 0 || i('t') < 0) continue;
      const rows = lines.slice(1).map((l) => {
        const c = l.split(',');
        const num = (k) => (i(k) < 0 || c[i(k)] === '' ? null : Number(c[i(k)]));
        return { t: num('t'), phase: c[i('phase')], edge: num('edge') || 0, cpu_s: num('cpu_s'), net_in: num('net_in') };
      });
      const w = windowsOf(rows, 'idle').windows.map((x) => x.cpu).filter((v) => v != null);
      if (w.length) vals.push(med(w));
    } catch { /* 坏文件跳过，不能让历史数据影响本次校准 */ }
  }
  return vals.filter((v) => Number.isFinite(v));
}

/**
 * 建议阈值 → 问要不要写回 config.conf。
 * 写回走 settings.upsertConfKey：只换值，行首缩进和行尾注释都留着。
 */
async function offerWriteBack(d) {
  if (!d?.ok) {
    console.log(c.dim('\n本次不写回：给不出可信的建议值（原因见上）。'));
    return;
  }

  const exists = existsSync(CONFIG_PATH);
  const curCpu = readConfKey('busyCheck.cpuThreshold');
  const curNet = readConfKey('busyCheck.netInKBps');
  const curCpuNum = Number(curCpu);
  const same = Number.isFinite(curCpuNum) && Math.abs(curCpuNum - d.cpu) < 0.05;

  console.log(c.bold('\n是否把本次测出的阈值写入 config.conf？'));
  console.log(`  ${'busyCheck.cpuThreshold'.padEnd(28)} 现在 ${curCpu ? `${curCpu} 核` : c.dim('（空）')}  →  建议 ${c.yellow(`${d.cpu} 核`)}`);
  console.log(`  ${'busyCheck.netInKBps'.padEnd(28)} 现在 ${curNet || c.dim('（空）')}     →  建议 ${c.yellow(`${d.netKB} KB/s`)}`);
  if (same) console.log(c.dim(`  两者差不到 0.05，可以不改（现有值已经落在本例推算的合理区间里）。`));
  if (!exists) console.log(c.dim('  （config.conf 还不存在，会新建）'));

  const ans = (await ask('  写入？[y/N] ')).trim().toLowerCase();
  if (ans !== 'y' && ans !== 'yes') {
    console.log(c.dim('  已跳过，config.conf 未改动。'));
    return;
  }

  const r1 = upsertConfKey('busyCheck.cpuThreshold', d.cpu);
  if (!r1.ok) { console.log(c.red(`  写回失败：${r1.reason}`)); return; }
  const r2 = upsertConfKey('busyCheck.netInKBps', d.netKB);
  if (!r2.ok) { console.log(c.red(`  netInKBps 写回失败：${r2.reason}（cpuThreshold 已写入）`)); return; }

  console.log(c.green(`  已写入 ${CONFIG_PATH}`));
  console.log(c.dim('  下一次签到就按新阈值判定，不需要重装定时任务。'));
}

// ──────────────────────────── 入口 ────────────────────────────

/**
 * 交互式校准。签到的并发锁在这里不适用（校准只读系统数据，不碰客户端）。
 * @param {string[]} argv cli.mjs 传进来的参数（--calibrate 已被摘掉）
 */
export async function run(argv = []) {
  const num = (name, dflt) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a ? Number(a.split('=')[1]) || dflt : dflt;
  };
  const interval = num('interval', 3) * 1000;      // 采样间隔（nettop 单次 1~2s，3s 稳妥）
  const idleSecs = num('idle', 60);
  const fallbackSecs = num('fallback', 60);
  const outArg = argv.find((x) => x.startsWith('--out='));
  // 默认落盘位置跟签到日志放在一起，且**基于项目根**而不是 cwd ——
  // 基于 cwd 的话，在别的目录执行会写到一个莫名其妙的地方。
  const out = outArg
    ? (isAbsolute(outArg.split('=')[1]) ? outArg.split('=')[1] : resolve(process.cwd(), outArg.split('=')[1]))
    : join(logDir(), `calibrate-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);

  cfg = { interval, idleSecs, fallbackSecs, out };
  resetState(out);

  console.log(c.bold('\n豆包忙闲探测 · 校准实验（用户控制节奏）'));
  console.log('─'.repeat(76));
  console.log(`  阶段：空闲基线 ${idleSecs} 秒 → 纯对话（你控制）→ 对话回落 ${fallbackSecs} 秒`);
  console.log(`        → 任务执行（你控制）→ 任务回落 ${fallbackSecs} 秒`);
  console.log(`  采样间隔 ${interval / 1000} 秒 · 交互阶段不剔起始样本，尾部按 CPU 跃变智能剔除`);

  // readline 必须在"找豆包"之前建：下面要读回车，没有它就没法等。
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on('line', (line) => {
    const r = pending;
    if (r) { pending = null; r(line); } else queued.push(line);
  });
  rl.on('SIGINT', () => { console.log(c.yellow('\n已中止')); process.exit(130); });
  rl.on('close', () => {
    inputClosed = true;
    if (!pending) return;   // 没人在等就只是正常收尾
    console.log(c.yellow('\n输入已结束，没法继续交互。'));
    console.log('这个脚本要在终端里直接跑：./scripts/doubao-checkin.sh --calibrate');
    process.exit(1);
  });

  // 豆包没开不算出错：提示用户打开，等能读到进程再往下走。
  // 不能直接报错退出 —— 用户打开豆包后还得从头重跑一遍。
  let pids = await treePids(true);
  if (!pids.length) {
    console.log(c.yellow('\n  现在没找到豆包客户端进程。'));
    console.log('  请先照平常那样打开豆包（普通模式，不要带任何调试参数），');
    console.log('  打开后回到这个终端按回车，我重新检测。');
    console.log(c.dim('  校准只读系统数据，不会启动、重启或关闭豆包。'));
    for (;;) {
      await waitEnter('');
      pids = await treePids(true);
      if (pids.length) break;
      console.log(c.yellow('  还是没找到。确认豆包已经打开了，再按一次回车（想放弃按 Ctrl+C）。'));
    }
    console.log(c.green(`  找到了：${pids.length} 个进程（主 pid ${pids[0]}）`));
  } else {
    console.log(`\n  进程树：${pids.length} 个进程（主 pid ${pids[0]}）`);
  }

  // 自检
  phase = 'wait';
  await takeSample();
  const ok = Object.entries(dataStatus).filter(([, v]) => v).map(([k]) => k);
  const bad = Object.entries(dataStatus).filter(([, v]) => !v).map(([k]) => k);
  console.log(c.bold('\n数据源自检：'));
  console.log(`  ${c.green('可用')}：${ok.join(', ') || '（无）'}`);
  if (bad.length) console.log(`  ${c.red('不可用')}：${bad.join(', ')} → 对应信号这轮采不到`);
  samples.length = 0;

  console.log(c.yellow('\n请让豆包客户端保持空闲状态（没有任何任务在运行），按回车开始'));
  await waitEnter();

  // 采样循环：独立于交互流程，每 interval 一次
  const sampler = setInterval(() => { takeSample().catch(() => {}); }, interval);

  try {
    await runPhase('idle', { fixed: idleSecs, quiet: '什么都别做，别碰豆包窗口、别打字' });

    await runPhase('chat', {
      interactive: true,
      hint: '请在豆包里输入对话提示词并发送（例如「以「秋天的傍晚」为题，写一篇 2000 字的小说」），让它写长回答',
      note: '这一阶段要的是「纯对话」：不要让豆包调用工具或生成文件，只让它一直写字',
    });

    await runPhase('chat_fallback', { fixed: fallbackSecs, quiet: '什么都别点，观察指标回落' });

    await runPhase('task', {
      interactive: true,
      hint: '请在豆包里输入任务提示词并发送（例如「写一个 Python 脚本并运行，把结果打印出来」）',
      note: '这一阶段要触发工具调用 / 代码执行，和上面的纯对话拉开差距',
    });

    await runPhase('task_fallback', { fixed: fallbackSecs, quiet: '什么都别点，观察指标回落' });

    const stats = Object.fromEntries(KEYS.map((k) => [k, phaseStats(samples, k)]));
    const d = deriveThresholds(samples, { historyIdle: historyIdleMedians(out) });
    printTable(stats);
    printDerivation(d, stats);
    writeCsv();
    await offerWriteBack(d);
  } finally {
    // 收尾：清掉采样定时器，否则进程会一直挂着不退出
    clearInterval(sampler);
    rl.close();
  }
}
