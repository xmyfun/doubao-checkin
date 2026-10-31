/**
 * 日志。
 *
 * 两份文件，各司其职：
 *   checkin.log    人读的流水账。只在「真签到成功」或「出错」时写完整一段，
 *                  空跑（已签过）不写，免得有价值记录被淹没。
 *   history.jsonl  机读。每次运行一行 JSON，包括空跑，用于 --log 统计和排查。
 *
 * 位置：默认放项目内的 logs/，随项目走，方便打包和查看。
 *   例外：如果项目恰好放在 ~/Documents、~/Desktop、~/Downloads 下，
 *   这几个目录受 macOS TCC 保护，launchd 后台进程读不到（Operation not permitted），
 *   此时自动回退到 ~/Library/Logs/doubao-checkin/。
 *   也可以用 config.conf 的 logDir 强制指定。
 */

import {
  appendFileSync, existsSync, mkdirSync, renameSync, statSync, readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MAX_LOG = 2 * 1024 * 1024;      // checkin.log 单文件上限
const MAX_HISTORY = 5 * 1024 * 1024;  // history.jsonl 单文件上限

/**
 * 展开路径。
 *
 * 为什么需要：Node 的 fs 不解析 `~`，而用户在环境变量里很容易写成 `~/logs`。
 * launchd 同样不解析 `~`，所以 install 脚本会把绝对路径写进 plist；
 * 但命令行手动跑时仍可能带上 `~`，这里兜一层。
 */
export function expandPath(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (!isAbsolute(p)) return resolve(ROOT, p);   // 相对路径按项目根解析
  return p;
}

/** 这几个目录受 TCC 保护，后台进程读不到 */
function tccProtected(p) {
  const home = homedir();
  return ['Documents', 'Desktop', 'Downloads'].some((d) => p.startsWith(join(home, d)));
}

/** config.conf 里的 logDir 会通过这个覆盖（空 = 用默认位置） */
let overrideLogDir = '';
export function setLogDir(dir) { overrideLogDir = dir ? expandPath(dir) : ''; }

export function logDir() {
  if (overrideLogDir) return overrideLogDir;
  if (tccProtected(ROOT)) return join(homedir(), 'Library', 'Logs', 'doubao-checkin');
  return join(ROOT, 'logs');
}

export function logPath() { return join(logDir(), 'checkin.log'); }
export function historyPath() { return join(logDir(), 'history.jsonl'); }

/**
 * 显示宽度：中日韩全角字符算 2 列，其余算 1 列。
 * 中英混排的表格只用 `.length` 对齐会错位，必须按列宽算。
 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

/**
 * 按显示宽度折行，一个字符都不丢。
 *
 * 为什么要有：按字符数硬截（`slice(0, 34)`）会在句子中间断开，
 * 中文尤其明显，看上去像输出被截断了（例如「…，本次」后面的「跳过。」没了）。
 * 折行比截断更适合这一列 —— 说明文字本身就是最该看全的部分。
 *
 * 断行规则（避头尾）：
 *   - ASCII 连写（如 `1.2KB/s`）整体不拆，避免把数字和单位切开；
 *   - 不能把「，。、）」这类收尾标点丢到下一行行首，它会跟着前一个字一起走；
 *   - 不能把「（《「」这类起始标点留在行尾，它会跟着后一个字一起走。
 */
export function wrapDisplay(text, width) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return [''];
  const max = Math.max(4, Math.floor(width));

  // 一个 token = 一串可打印 ASCII（含紧随其后的一个空格），或者单个非 ASCII 字符
  const raw = s.match(/[\x21-\x7E]+ ?|[\s\S]/gu) ?? [];

  // 避头尾合并：收尾标点粘到前一块，起始标点粘到后一块
  const TAIL = new Set([...'，。、；：？！）】》」』”’,.;:!?)]}%']);
  const HEAD = new Set([...'（【《「『“‘([{']);
  const tokens = [];
  for (const tk of raw) {
    const first = [...tk][0];
    const single = [...tk].length === 1;
    if (single && TAIL.has(first) && tokens.length) {
      tokens[tokens.length - 1] += tk;
      continue;
    }
    if (tokens.length && HEAD.has([...tokens[tokens.length - 1]].at(-1)) && [...tokens[tokens.length - 1]].length === 1) {
      tokens[tokens.length - 1] += tk;
      continue;
    }
    tokens.push(tk);
  }

  const out = [];
  let cur = '';
  let cw = 0;
  const flush = () => { if (cur) { out.push(cur.replace(/ +$/, '')); cur = ''; cw = 0; } };

  for (const tk of tokens) {
    const tw = displayWidth(tk);
    const ascii = /^[\x21-\x7E]/.test(tk);
    if (tw > max && ascii) {              // 极长的英文串：只能逐字拆
      for (const ch of tk) {
        const chW = displayWidth(ch);
        if (cw + chW > max) flush();
        cur += ch;
        cw += chW;
      }
      continue;
    }
    if (cw + tw > max) flush();           // 中文块不拆（可能带标点），宁可换行
    cur += tk;
    cw += tw;
  }
  flush();
  return out.length ? out : [''];
}

function ensureDir() {
  try { mkdirSync(logDir(), { recursive: true }); } catch { /* ignore */ }
}

/** 超过上限就改名成 .1（保留一代），避免无限增长 */
function rotate(file, max) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < max) return;
    renameSync(file, `${file}.1`);
  } catch { /* 轮转失败不影响写入 */ }
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把一段运行过程写成人类可读的日志。
 * @param {{at:number,msg:string}[]} timeline
 * @param {object} meta  附加信息，写在段尾
 */
export function writeRun(timeline, meta = {}) {
  try {
    ensureDir();
    const file = logPath();
    rotate(file, MAX_LOG);

    const start = timeline[0]?.at || Date.now();
    const out = [`===== ${fmtTime(start)} =====`];
    for (const item of timeline) {
      if (!item.msg) continue;
      // 跳过纯分隔线，日志里没意义
      if (/^[─━=\-\s]+$/.test(item.msg)) continue;
      out.push(`[${fmtTime(item.at)}] ${item.msg}`);
    }
    if (meta.duration_ms != null) {
      out.push(`[${fmtTime(Date.now())}] 耗时       ${(meta.duration_ms / 1000).toFixed(1)}s`);
    }
    out.push('');
    appendFileSync(file, out.join('\n'));
  } catch { /* 日志写不了也不能让签到失败 */ }
}

/** 每次运行都追加一行，包括空跑。用于 --log 和统计 */
export function appendHistory(record) {
  try {
    ensureDir();
    const file = historyPath();
    rotate(file, MAX_HISTORY);
    appendFileSync(file, JSON.stringify(record) + '\n');
  } catch { /* ignore */ }
}

/**
 * 读最近 n 条运行记录（新的在前）。
 *
 * 结果名只有一套：SUCCESS / ALREADY / SKIPPED / BUSY / CIRCUIT / PENDING / FAIL / AUTH_FAIL / UNKNOWN。
 * `SKIPPED` 与 `BUSY` 都表示"这次没做"，但原因相反：
 *   SKIPPED = 今天已经签过了（读历史记录就退出，或拿到锁失败），**任务已完成**
 *   BUSY    = 客户端正在跑任务，这次没敢重启，**今天可能因此漏签**
 *   CIRCUIT = 连续失败已触发熔断，**自动重试已经停了，需要人处理**
 * 混成一个名字的后果是 `--log` 里看不出风险 —— 统计里会显示"都正常"，
 * 实际却有一天没签成。所以这几个值必须分开记、分开算。
 */
export function readHistory(n = 20) {
  try {
    const file = historyPath();
    if (!existsSync(file)) return [];
    const rows = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
    return rows.reverse();
  } catch { return []; }
}

/** 统计用：连续成功天数、最近失败 */
export function summarize(rows) {
  const claims = rows.filter((r) => r.result === 'SUCCESS' || r.result === 'ALREADY');
  const fails = rows.filter((r) => r.needs_attention);
  return {
    total: rows.length,
    claimed: rows.filter((r) => r.result === 'SUCCESS').length,
    already: rows.filter((r) => r.result === 'ALREADY').length,
    skipped: rows.filter((r) => r.result === 'SKIPPED').length,
    // 遇忙跳过单独计数：它和「今天已签所以跳过」的后果完全相反 ——
    // 一个是任务完成，一个是今天可能就这么漏掉了。混成一个数字等于把风险藏起来。
    busy: rows.filter((r) => r.result === 'BUSY').length,
    // 熔断跳过单独计数：它和「今天已签所以跳过」完全不是一回事 ——
    // 一个是任务完成，一个是"任务已经连续失败到自动停工了"。
    circuit: rows.filter((r) => r.result === 'CIRCUIT').length,
    // 下面两类都不是"签到结果"，但都会留在 history 里。
    // 不单独统计的话，`--log` 底部各项加起来会小于总次数，看着像丢记录。
    repair: rows.filter((r) => r.result === 'REPAIR').length,
    pending: rows.filter((r) => r.result === 'PENDING').length,
    failed: fails.length,
    lastOk: claims[0]?.at || null,
    lastFail: fails[0]?.at || null,
  };
}
