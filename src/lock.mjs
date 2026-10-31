/**
 * 单实例锁。
 *
 * 为什么必须有：launchd 里同时配了 StartCalendarInterval（两个时刻）和
 * StartInterval（每小时兜底），这两套触发是独立的，叠跑是必然的。
 * 而叠跑的后果特别糟 —— 两个进程同时 pkill 豆包再 open，
 * Chromium 的单实例锁会让其中一个失败，签到直接崩。
 *
 * 用 mkdir 而不是 writeFile：mkdir 是原子操作，天然互斥。
 * 但还要处理僵尸锁（上次被 SIGKILL 留下的），靠 pid 存活检测。
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK_DIR = join(ROOT, '.lock');

/**
 * 锁目录可以重定向（只给测试用）。
 * 不重定向的话，单测会直接在项目根目录建 .lock —— 一旦此刻真有定时任务在跑，
 * 双方抢同一把锁，测试就随机失败（真实撞到过一次：4 个 lock 测试全挂）。
 */
let overrideLockDir = '';
export function setLockDir(dir) { overrideLockDir = dir || ''; }

const lockDir = () => overrideLockDir || DEFAULT_LOCK_DIR;
const pidFile = () => join(lockDir(), 'pid');

let held = false;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanup() {
  if (!held) return;
  try { rmSync(lockDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  held = false;
}

/**
 * @returns {{ ok: boolean, holder?: number, stale?: boolean }}
 */
export function acquireLock() {
  try {
    mkdirSync(lockDir());
  } catch {
    // 锁已存在：判断是真在跑，还是僵尸
    let pid = NaN;
    try { pid = Number(readFileSync(pidFile(), 'utf8').trim()); } catch { /* pid 文件可能还没写 */ }

    if (alive(pid)) return { ok: false, holder: pid };

    // 僵尸锁（进程已死但目录还在）：清掉重来
    try { rmSync(lockDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    try {
      mkdirSync(lockDir());
    } catch {
      // 清完还是建不了，说明有别的进程刚好抢到了
      return { ok: false, stale: true };
    }
  }

  try { writeFileSync(pidFile(), String(process.pid)); } catch { /* 写不了 pid 也能用 */ }
  held = true;

  // 无论怎么退出都要释放，否则下次永远拿不到锁
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => process.exit(0));
  }
  return { ok: true };
}

export function releaseLock() { cleanup(); }

export function lockPath() { return lockDir(); }

export function isLocked() {
  if (!existsSync(lockDir())) return false;
  let pid = NaN;
  try { pid = Number(readFileSync(pidFile(), 'utf8').trim()); } catch { /* ignore */ }
  return alive(pid);
}
