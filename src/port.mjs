/**
 * CDP 端口管理。
 *
 * 设计原则（2026-10-23 修正）：
 *   不要靠"扫一段连续端口"去找 CDP。豆包一个进程会监听到 19 个端口，
 *   其中只有一个是 CDP，端口号没有任何规律（14013/14016/49853 这种是动态分配的）。
 *   猜范围等于赌运气，赌错了就把本来正常的实例杀掉重启。
 *
 * 正确做法：
 *   ① 问进程：豆包现在监听哪些端口
 *   ② 逐个验证：谁能响应 /json/version 且 target 里有 doubao://
 *   ③ 找不到才启动，启动时从默认端口开始找空闲的，被占就自动往后挪
 */

import { execFileSync } from 'node:child_process';
import net from 'node:net';

/** 端口是否已被监听（同步，用 lsof） */
export function isPortInUse(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // lsof 退出码 1 表示没有监听者
    return false;
  }
}

/**
 * 解析 `lsof -nP -c Doubao -iTCP -sTCP:LISTEN` 的输出，取出监听端口。
 *
 * 抽成纯函数是为了能单测：lsof 的列宽、IPv6 写法（`[::1]:42050`）、
 * 同一端口既在 IPv4 又在 IPv6 上监听，这些细节不值得靠真机反复试。
 */
export function parseListeningPorts(out) {
  const ports = new Set();
  for (const line of String(out || '').split('\n').slice(1)) {
    // 形如：TCP 127.0.0.1:9225 (LISTEN)  或  TCP [::1]:42050 (LISTEN)  或  TCP *:14013 (LISTEN)
    const m = line.match(/TCP\s+(?:\[[^\]]*\]|[^:\s]+):(\d+)\s+\(LISTEN\)/);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * 豆包所有进程当前监听的端口（不猜范围，直接问进程）。
 *
 * 用 `-c Doubao` 同时匹配主进程 Doubao 和 helper "Doubao Browser"。
 * 注意：返回的是全部监听端口，绝大多数是内部 IPC，需要逐个验证才是 CDP。
 */
export function doubaoListeningPorts() {
  try {
    const out = execFileSync('lsof', ['-nP', '-c', 'Doubao', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseListeningPorts(out);
  } catch {
    return [];
  }
}

/** 这个端口上是不是豆包的 CDP（靠 doubao:// target 判定，不看版本号） */
export async function isDoubaoEndpoint(port, timeoutMs = 1500) {
  try {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!v.ok) return false;

    const list = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!list.ok) return false;
    const targets = await list.json();
    if (!Array.isArray(targets) || targets.length === 0) return false;

    return targets.some((t) => {
      const u = t.url || '';
      return u.startsWith('doubao://') || u.includes('doubao.com');
    });
  } catch {
    return false;
  }
}

/**
 * 在豆包已经监听的端口里，找出哪个是 CDP。
 * @returns {Promise<{port:number, ports:number[]}|null>}
 */
export async function findDoubaoCdpPort() {
  const ports = doubaoListeningPorts();
  for (const p of ports) {
    if (await isDoubaoEndpoint(p)) return { port: p, ports };
  }
  return { port: null, ports };
}

/** 用 Node 自己试绑一次，双保险（lsof 偶尔漏报 TIME_WAIT 之类） */
export function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, '127.0.0.1');
    } catch {
      resolve(false);
    }
  });
}

/**
 * 从 start 开始找第一个真正可用的端口。
 * 先用 lsof（快），再用试绑（准）—— 后者能挡住 lsof 漏报的情况。
 *
 * @param {number} start   起始端口
 * @param {number} count   往后找多少个
 * @param {number[]} exclude 已经试过、要跳过的
 */
export async function pickFreePort(start, count = 30, exclude = []) {
  const skip = new Set(exclude);
  for (let i = 0; i < count; i++) {
    const p = start + i;
    if (p > 65535) break;
    if (skip.has(p)) continue;
    if (isPortInUse(p)) continue;
    if (!(await canBind(p))) continue;
    return p;
  }
  return null;
}

/** 谁在占这个端口（报错时给出可操作信息） */
export function whoOwns(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.trim().split('\n')[1];
    if (!line) return null;
    const parts = line.split(/\s+/);
    return { command: parts[0], pid: Number(parts[1]) };
  } catch {
    return null;
  }
}

/** 端口占用概览，给 doctor 用 */
export function portConflicts(start, count = 10) {
  const result = [];
  for (let p = start; p < start + count; p++) {
    if (!isPortInUse(p)) continue;
    const o = whoOwns(p);
    result.push({ port: p, command: o?.command || '?', pid: o?.pid || 0 });
  }
  return result;
}
