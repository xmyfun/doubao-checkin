/**
 * 忙闲探测：判断豆包客户端此刻是不是在执行任务。
 *
 * 为什么要做成"窗口 + 中位数"，而不是看一眼瞬时值：
 *   实测（2026-10-24）任务执行过程中，CPU 会有一段 18 秒的低谷
 *   （0.31~0.36 核，和空闲的 0.30 几乎一样），因为模型在思考/等远端。
 *   如果只看某一个瞬间，有 40% 概率正好落在低谷里，
 *   就会把"正在跑任务"判成"空闲"，然后把它重启掉。
 *
 * 结论（实测校准得出）：
 *   · CPU 是主判据，忙闲分离度约 3.5~4 倍
 *   · 网入是辅助判据，能补上 CPU 低谷期（那时网入仍有 7~17 KB/s）
 *   · 派生进程不可用：豆包跑 Python 脚本时**不会**在本地 spawn 子进程，
 *     实测进程数从头到尾恒为 20，一个 python3 都没出现（远端沙箱执行）
 *   · 磁盘读不到（macOS 上 top -stats disk 无输出），已放弃
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

async function sh(cmd, argv, timeout = 8000) {
  try {
    const { stdout } = await execFileP(cmd, argv, { timeout, encoding: 'utf8' });
    return stdout;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 豆包进程树（主进程 + 全部后代）。派生进程判断已放弃，这里只数个数 */
export async function processTree() {
  const out = await sh('ps', ['-axo', 'pid=,ppid=,comm=']);
  if (!out) return { pids: [], count: 0 };
  const rows = out.split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 3 && /^\d+$/.test(r[0]));
  const byParent = new Map();
  for (const r of rows) {
    const pid = Number(r[0]); const ppid = Number(r[1]);
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const roots = rows.filter((r) => /Doubao/i.test(r[2])).map((r) => Number(r[0]));
  const tree = new Set();
  const walk = (pid, depth = 0) => {
    if (tree.has(pid) || depth > 12) return;
    tree.add(pid);
    for (const kid of (byParent.get(pid) || [])) walk(kid, depth + 1);
  };
  for (const r of roots) walk(r);
  return { pids: [...tree].sort((a, b) => a - b), count: tree.size };
}

/** ps -o cputime= 的三种格式：MM:SS.ff / HH:MM:SS[.ff] / D-HH:MM:SS[.ff] */
export function parseCpuTime(s) {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(?:(\d+)-)?(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
  if (m) {
    return Number(m[1] || 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
      + Number(m[5] || 0) / Math.pow(10, (m[5] || '').length);
  }
  m = t.match(/^(\d+):(\d+)(?:\.(\d+))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] || 0) / Math.pow(10, (m[3] || '').length);
  return null;
}

async function cpuSeconds(pids) {
  if (!pids.length) return null;
  const out = await sh('ps', ['-o', 'cputime=', '-p', pids.join(',')]);
  if (!out) return null;
  let sum = 0; let ok = false;
  for (const line of out.split('\n')) {
    const v = parseCpuTime(line);
    if (v !== null) { sum += v; ok = true; }
  }
  return ok ? sum : null;
}

/** 豆包各进程的累计收发字节（nettop 按进程汇总） */
export async function netBytes() {
  const out = await sh('nettop', ['-P', '-L', '1']);
  if (!out) return null;
  let i = 0; let o = 0; let seen = false;
  for (const line of out.split('\n')) {
    const f = line.split(',');
    if (f.length < 6 || !/doubao/i.test(f[1] || '')) continue;
    seen = true; i += Number(f[4]) || 0; o += Number(f[5]) || 0;
  }
  return seen ? { i, o } : null;
}

/** 采一个样本（计数器累计值，速率要靠前后差值算） */
export async function collectOnce() {
  const tree = await processTree();
  const [cpu, net] = await Promise.all([cpuSeconds(tree.pids), netBytes()]);
  return { t: Date.now(), procs: tree.count, cpu_s: cpu, net_in: net?.i ?? null, net_out: net?.o ?? null };
}

/**
 * 纯函数：根据一串样本判断忙闲。抽出来是为了能单测（不依赖真实进程）。
 *
 * @param {Array<{t:number,cpu_s:number|null,net_in:number|null}>} samples
 * @param {{cpuThreshold:number, netInKBps:number}} th
 */
export function judgeWindow(samples, th) {
  const rates = [];
  const netRates = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]; const b = samples[i];
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0)) continue;
    // 两个计数器都钳到 0：客户端重启后 cputime / 收发字节会从 0 重新累计，
    // 差值会是负数。负数既不该参与排序（会把中位数拉到 0 以下，`--log` 里
    // 显示成"CPU 中位 -0.12 核"），也不该当成"负的使用率"。
    // 钳 0 后结论方向不变（0 同样低于阈值），但显示和 calibrate 侧的 delta() 一致。
    if (a.cpu_s !== null && b.cpu_s !== null) rates.push(Math.max(0, (b.cpu_s - a.cpu_s) / dt));
    if (a.net_in !== null && b.net_in !== null) netRates.push(Math.max(0, (b.net_in - a.net_in) / dt));
  }
  // 中位数取「上中位」：个数为偶数时取偏大的那个（30 秒窗口是 10 个速率，
  // 一直是偶数）。偏大 = 更容易判忙，这与判定方向一致 —— 宁可今天漏签（有兜底），
  // 也不要把用户正在跑的任务重启掉。test/busy.test.mjs 里钉住了这个行为。
  const med = (arr) => {
    if (!arr.length) return null;
    const v = [...arr].sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };
  const cpuMed = med(rates);
  const netMed = med(netRates);

  const reasons = [];
  if (cpuMed !== null && cpuMed > th.cpuThreshold) {
    reasons.push(`CPU 中位 ${cpuMed.toFixed(2)} 核 > ${th.cpuThreshold} 核`);
  }
  if (netMed !== null && netMed > th.netInKBps * 1024) {
    reasons.push(`网入中位 ${(netMed / 1024).toFixed(1)}KB/s > ${th.netInKBps}KB/s`);
  }

  return {
    busy: reasons.length > 0,
    reasons,
    cpuMedian: cpuMed,
    netInMedian: netMed,
    samples: samples.length,
    evaluable: rates.length > 0 || netRates.length > 0,
  };
}

/**
 * 观察一个窗口，给出忙闲结论。
 * @returns {Promise<ReturnType<typeof judgeWindow> & {procsMax:number}>}
 */
export async function probeBusy({ windowSeconds, sampleSeconds, cpuThreshold, netInKBps, onSample }) {
  const samples = [];
  const end = Date.now() + windowSeconds * 1000;
  while (Date.now() < end) {
    const s = await collectOnce();
    samples.push(s);
    onSample?.(s, samples);
    const left = end - Date.now();
    if (left < sampleSeconds * 1000) break;
    await sleep(sampleSeconds * 1000);
  }
  const verdict = judgeWindow(samples, { cpuThreshold, netInKBps });
  return { ...verdict, procsMax: Math.max(0, ...samples.map((s) => s.procs)) };
}
