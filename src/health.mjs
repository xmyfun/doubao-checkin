/**
 * 客户端健康快照 —— **只读**，不启停客户端、不写任何文件。
 *
 * 为什么单独成一个模块：真正能定位问题的三个信号（`profile.exit_type`、
 * GPU 缓存的最后写入时间、进程构成）平时没人采集，出故障时只能临时敲命令现查。
 * 收进来之后，`--doctor` 和 `--repair` 才能共用同一份判断。
 *
 * 所有函数都接受 `userDataDir` / `appPath` 参数而不是内部写死路径，
 * 这样单测能指向临时目录，不会读到开发者本机的真实数据。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 豆包客户端的 user-data 目录（macOS 按应用名放在这里，与 appPath 无关） */
export const USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Doubao');

/**
 * 可以安全清理的缓存目录（相对 user-data 根）。
 *
 * 只挑**完全可再生**的：GPU 与着色器缓存。删了客户端会重算，不丢聊天记录、
 * 不丢登录态、不丢任何用户数据。会话数据（Cookies / IndexedDB /
 * Local Storage / Session Storage）一个都不在这里，也永远不该进来。
 */
export const GPU_CACHE_DIRS = ['Default/GPUCache', 'GrShaderCache', 'GraphiteDawnCache'];

/**
 * Chromium 记录的"上次会话是怎么结束的"。
 *
 * 取值实测见到的是 `Crashed`（被 SIGKILL 之后）；正常退出应为 `Normal`
 * （本仓库没有实测样本，只按 Chromium 的命名习惯写）。
 * **它不是任何参数**，是 `Default/Preferences` 这个 JSON 文件里的一个键。
 *
 * ⚠️ 它只是痕迹，不是病因：白屏时它也是 Crashed，但把它改回 Normal 并不会修好白屏。
 * 所以 repair 不去动它 —— 留着反而是"上次异常退出过"的信号。
 *
 * @returns {string|null} 读不到或格式不对时返回 null（绝不抛）
 */
export function readExitType(userDataDir = USER_DATA_DIR) {
  try {
    const raw = readFileSync(join(userDataDir, 'Default', 'Preferences'), 'utf8');
    const j = JSON.parse(raw);
    const t = j?.profile?.exit_type;
    return typeof t === 'string' ? t : null;
  } catch {
    return null;
  }
}

/**
 * 三个 GPU 缓存目录的现状。
 *
 * mtime 是判断"GPU 进程有没有在干活"最便宜的信号：故障那次客户端跑了 20 分钟，
 * 三个目录的 mtime 全停在几天前，一个字节都没写。
 *
 * @returns {{rel:string, exists:boolean, bytes:number, files:number, mtimeMs:number|null, ageHours:number|null}[]}
 */
export function cacheStatus(userDataDir = USER_DATA_DIR, now = Date.now()) {
  return GPU_CACHE_DIRS.map((rel) => {
    const dir = join(userDataDir, rel);
    try {
      const st = statSync(dir);
      let bytes = 0;
      let files = 0;
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          files += 1;
          try { bytes += statSync(full).size; } catch { /* 单个文件读不到不影响整体 */ }
        }
      };
      walk(dir);
      return {
        rel, exists: true, bytes, files,
        mtimeMs: st.mtimeMs,
        ageHours: (now - st.mtimeMs) / 3600_000,
      };
    } catch {
      return { rel, exists: false, bytes: 0, files: 0, mtimeMs: null, ageHours: null };
    }
  });
}

/** 应用包本身的修改时间 —— 最近变过说明刚更新/重装，版本问题的嫌疑上升 */
export function appMtime(appPath) {
  try { return statSync(appPath).mtimeMs; } catch { return null; }
}

/**
 * 把小时数说成人话。doctor 的表格里空间有限，`18 天前` 比 `432 小时前` 好读。
 */
export function formatAge(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '未知';
  if (hours < 1) return '1 小时内';
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  const d = Math.round(hours / 24);
  return `${d} 天前`;
}

/** 缓存总量，用于在输出里给一个"要不要清"的直觉 */
export function cacheTotalBytes(list) {
  return list.reduce((n, c) => n + (c.bytes || 0), 0);
}

export function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 ** 2).toFixed(1)}M`;
}
