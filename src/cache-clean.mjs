/**
 * 备份并清空 GPU 缓存 —— `--repair` 三步里的第二步。
 *
 * 单独成模块的理由只有一条：**它会 rm -rf**。这类代码必须能被单测覆盖，
 * 而 bin/checkin.mjs 有顶层副作用（读参数、连客户端），没法 import 来测。
 *
 * 三条硬约束，任何一条不满足就跳过而不是继续：
 *   1. 源目录必须真的在 userDataDir 下面（防止路径拼接出 bug 删到别处）
 *   2. 先 cpSync 备份，再数文件数，**对得上才删源**
 *   3. 只碰 GPU/着色器缓存，会话数据（Cookies / IndexedDB / Local Storage /
 *      Session Storage）不在这里，也永远不该进来
 */

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GPU_CACHE_DIRS, USER_DATA_DIR } from './health.mjs';

/** 递归数文件个数与总字节 —— 用来校验备份完整性、以及告诉用户清了多少 */
export function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const s = dirStats(full);
        files += s.files;
        bytes += s.bytes;
      } else {
        files += 1;
        try { bytes += statSync(full).size; } catch { /* 单个文件读不到就少算 */ }
      }
    }
  } catch { /* 读不到按 0 算：校验会因此失败并中止，不会误删 */ }
  return { files, bytes };
}

/**
 * @param {string} destRoot  备份根目录（通常是 backup/repair-<时间戳>/）
 * @param {string} userDataDir  客户端 user-data 目录
 * @returns {{rel:string, bytes?:number, files?:number, skipped?:boolean, error?:string}[]}
 */
export function backupAndClearCaches(destRoot, userDataDir = USER_DATA_DIR) {
  const rootResolved = resolve(userDataDir);
  const out = [];

  for (const rel of GPU_CACHE_DIRS) {
    const src = resolve(join(userDataDir, rel));

    // 护栏：`resolve` 之后必须仍以 user-data 目录开头。
    // 万一 rel 里出现 `..` 或者配置写错，这一步会拦住，而不是删掉别处的目录。
    if (src !== rootResolved && !src.startsWith(rootResolved + '/')) {
      out.push({ rel, error: '路径不在 user-data 目录下，已跳过' });
      continue;
    }

    let st;
    try { st = statSync(src); } catch { out.push({ rel, skipped: true }); continue; }
    if (!st.isDirectory()) { out.push({ rel, skipped: true }); continue; }

    const stats = dirStats(src);
    const files = stats.files;
    const dest = join(destRoot, rel.replace(/\//g, '_'));

    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });

      const copied = dirStats(dest).files;
      if (copied !== files) {
        // 备份不完整就不删源 —— 缓存虽然可再生，但"以为备份了其实没有"是不可接受的状态
        out.push({ rel, error: `备份文件数不一致（${copied}/${files}），源目录未删除` });
        continue;
      }

      rmSync(src, { recursive: true, force: true });
      mkdirSync(src, { recursive: true });
      out.push({ rel, bytes: stats.bytes, files });
    } catch (e) {
      out.push({ rel, error: e.message.split('\n')[0] });
    }
  }

  return out;
}
