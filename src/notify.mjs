/**
 * macOS 桌面通知。
 *
 * 关键教训（来自 DavidLam-oss/workbuddy-auto-signin 的实测）：
 *   后台进程（launchd 直起的 node）调用 `display notification` 时，
 *   通知中心会静默丢弃 —— 不报错、也不显示。
 *   必须用 `display alert`（模态对话框），它直接命中前台 GUI 会话。
 *
 * 但 alert 是模态的：osascript 会一直等到用户点「好」。
 * 所以这里用 detached + unref 的方式启动，**不阻塞脚本**。
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, '.notify-state.json');

/** 默认去抖时长。可被 config.conf 的 notify.debounceHours 覆盖 */
const DEFAULT_DEBOUNCE_MS = 6 * 3600_000;

/**
 * 这一条该不该弹 —— **纯函数**，单独抽出来是为了能单测。
 *
 * notify() 本身不能测：它真的会调 osascript 弹窗，跑到用户屏幕上。
 * 2026-10-31 就是这么弹了一次测试窗、还把去抖名额占掉的。
 *
 * 去抖是**按 key 独立**的，不是全局：一个 key 只存一个时间戳，
 * 不同的 key 各算各的。key 由调用方决定（见 notify 的 opts.key），
 * 现在用的是提醒的原因：UNKNOWN / FAIL / AUTH_FAIL / CIRCUIT / ERR:<code>。
 *
 * @param {Record<string, number>} state  .notify-state.json 的内容
 * @param {string} key
 * @param {{now?: number, debounceMs?: number}} opts
 *   debounceMs <= 0 表示不去抖，永远返回 true
 */
export function shouldFire(state, key, { now = Date.now(), debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  if (!debounceMs || debounceMs <= 0) return true;
  const last = state[key] || 0;
  return now - last >= debounceMs;
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* ignore */ }
}

function esc(s) {
  // AppleScript 双引号字符串里的转义
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 弹一个不会被忽略的提醒。
 * @param {string} title
 * @param {string} message
 * @param {{ key?: string, debounce?: boolean, debounceMs?: number }} opts
 *   debounceMs 不传就用默认 6 小时；传 0 表示不去抖
 * @returns {boolean} 是否真的弹了（被去抖则返回 false）
 */
export function notify(title, message, opts = {}) {
  const key = opts.key || `${title}::${message.slice(0, 24)}`;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  if (opts.debounce !== false) {
    const state = readState();
    if (!shouldFire(state, key, { debounceMs })) return false;
    state[key] = Date.now();
    writeState(state);
  }

  const script = `display alert "${esc(title)}" message "${esc(message)}" as warning`;
  try {
    // detached + unref：不等待用户点击，脚本继续/退出
    const p = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    p.unref();
    return true;
  } catch {
    // alert 起不来时退回通知中心（可能被丢弃，但总比没有好）
    try {
      execFileSync('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], { timeout: 3000 });
    } catch { /* 通知失败绝不影响主流程 */ }
    return false;
  }
}

/** 测试用：清掉去抖状态 */
export function resetNotifyState() {
  try { writeFileSync(STATE_FILE, '{}'); } catch { /* ignore */ }
}

export function hasState() { return existsSync(STATE_FILE); }
