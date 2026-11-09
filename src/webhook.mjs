/**
 * 飞书群机器人推送 —— 纯逻辑 + 一次 HTTPS 请求，零运行时依赖。
 *
 * 规则（2026-11-09 定稿）
 *   · 手动运行不推送（结果已经在终端里了）；只有 --quiet（定时任务）按规则推。
 *   · --test-webhook 是显式强制开关：跳过 quiet 判定、结果过滤、当天去重，
 *     本次结果无论是什么都推一条。
 *   · 定时任务：SUCCESS 每次推；
 *       breaker.threshold ≠ 0 → 当天第一条 CIRCUIT 推一次，失败类不推；
 *       breaker.threshold = 0 → 没有 CIRCUIT 可推，改推当天第一条失败类。
 *   · 推送失败（超时 / 非 2xx / code≠0）只返回原因，绝不改结果、退出码或弹窗。
 *
 * 状态为什么独立存：history.jsonl 记的是「这次运行发生了什么」，而「今天有没有
 * 成功推过告警」是通知系统自己的状态。塞进 history 会污染运行记录；复用
 * .notify-state.json 又会和桌面弹窗互相静音。只有发送成功才写状态 —— 失败时
 * 下次运行仍算「当天首个」，会自动重试。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfKey } from './settings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_PATH = join(ROOT, '.webhook-state.json');
export const WEBHOOK_KEY = 'notify.feishuWebhook';

const MAX_TEXT = 4000;   // 飞书请求体上限 20KB；中文 4000 字仍留足余量
const TIMEOUT_MS = 5000;

/** 失败类结果。关掉熔断时，「当天首个失败」按这个集合 + needs_attention 判。 */
const FAILURE = new Set(['FAIL', 'AUTH_FAIL', 'UNKNOWN']);

export function todayKey(now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 日志里不许出现完整 webhook 地址：拿到地址就能往群里发消息 */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}/…${url.slice(-4)}`;
  } catch { return '(地址无效)'; }
}

/** 从 config.conf 读地址；留空 / 没这个文件 / 读不了都返回 '' */
export function readWebhookUrl(configPath) {
  return (readConfKey(WEBHOOK_KEY, configPath) || '').trim();
}

/** 熔断是否开启（threshold=0 表示关闭）。读不到按默认「开启」处理。 */
export function readBreakerEnabled(configPath) {
  const raw = readConfKey('breaker.threshold', configPath);
  if (raw === '') return true;
  const n = Number(raw);
  return Number.isFinite(n) ? n > 0 : true;
}

/**
 * 该不该推 —— **纯函数**，判定矩阵的唯一来源。
 *
 * @param {{result?:string, needs_attention?:boolean}} report
 * @param {{quiet:boolean, testWebhook?:boolean, breakerEnabled?:boolean,
 *          state?:object, today:string}} opts
 * @returns {{push:boolean, kind:'test'|'success'|'circuit'|'failure'|null}}
 */
export function shouldPush(report, opts) {
  const { quiet, testWebhook = false, breakerEnabled = true, state = {}, today } = opts;
  const result = report?.result ?? '';

  if (testWebhook) return { push: true, kind: 'test' };
  if (!quiet) return { push: false, kind: null };

  if (result === 'SUCCESS') return { push: true, kind: 'success' };

  if (result === 'CIRCUIT' && breakerEnabled) {
    return state.circuit === today
      ? { push: false, kind: null }
      : { push: true, kind: 'circuit' };
  }

  if (!breakerEnabled && (report?.needs_attention === true || FAILURE.has(result))) {
    return state.failure === today
      ? { push: false, kind: null }
      : { push: true, kind: 'failure' };
  }

  return { push: false, kind: null };
}

/**
 * 自检入口 bin/webhook-test.mjs 的参数解析（纯函数，单测可覆盖）。
 *
 * 只认三个键，全部可选：
 *   --url=<地址>      覆盖 config.conf 的地址，**只用于这一条测试消息**
 *   --script=<路径>   写进消息的签到脚本绝对路径（由向导给，就是 plist 里那个）
 *   --host=<主机名>   不传则由调用方用 os.hostname() 兜底
 *
 * 不给 --url 时返回空 url，调用方会从 config.conf 读；完全没配就 SKIP。
 * 传入了 --url 却不是 http(s) 地址，直接报错，不静默退化成「去发一个必然失败的请求」。
 */
export function parseTestArgs(argv = []) {
  const out = { url: '', scriptPath: '', host: '', error: '' };
  let urlGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--url') {
      urlGiven = true;
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith('--')) {
        out.error = '--url 后面要跟一个完整的地址';
        break;
      }
      out.url = String(next).trim();
      i += 1;
    } else if (a.startsWith('--url=')) {
      urlGiven = true;
      out.url = a.slice(6).trim();
    } else if (a.startsWith('--script=')) {
      out.scriptPath = a.slice(9).trim();
    } else if (a.startsWith('--host=')) {
      out.host = a.slice(7).trim();
    } else {
      out.error = `未知参数：${a}`;
      break;
    }
  }
  if (!out.error && urlGiven) {
    if (!out.url) out.error = '--url 不能为空';
    else if (!/^https?:\/\//i.test(out.url)) out.error = '--url 必须是 http(s):// 开头的完整地址';
  }
  return out;
}

/**
 * 固定文案里带「豆包签到」，配合可能开启的关键词安全设置。
 *
 * kind='install' 是安装向导的自检消息：内容只讲安装（完成 / 主机 / 脚本路径），
 * 与某一次签到的结果无关；kind='test' 是 --test-webhook 附着在签到结果上的强推，
 * 必须带上本次结果 —— 两者不要混成一条文案。
 */
export function buildText(report, kind, { now = new Date(), host = '', scriptPath = '' } = {}) {
  const head = {
    test: '【豆包签到 · webhook 自检】',
    install: '【豆包签到 · webhook 自检】',
    success: '【豆包签到 · 成功】',
    circuit: '【豆包签到 · 已停工】',
    failure: '【豆包签到 · 失败】',
  }[kind] || '【豆包签到】';
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${todayKey(now)} ${p(now.getHours())}:${p(now.getMinutes())}`;

  const lines = [head];
  if (kind === 'install') {
    // 「安装完成」由调用方保证：向导只在 launchctl bootstrap 成功之后才发这条消息。
    lines.push(`${stamp} · 定时任务安装完成`);
    lines.push(`主机  ${host || '未知'}`);
    lines.push(`脚本  ${scriptPath || '未知'}`);
  } else {
    const cv = typeof report?.client === 'string' ? report.client : report?.client?.version;
    lines.push(`${stamp} · 客户端 ${cv || '未知'}`);
    lines.push(`结果 ${report?.result || '本次自检'}：${report?.report || ''}`);
  }
  if (kind === 'test' || kind === 'install') {
    lines.push('定时任务只推送「签到成功」与「当天首个告警」，手动运行不推送。');
  }
  if (kind === 'circuit') lines.push('连续失败已触发熔断，自动重试已暂停，需要人工处理。');
  return lines.join('\n').slice(0, MAX_TEXT);
}

/**
 * 发一条文本消息。可注入 fetchImpl 做单测，绝不发真实网络。
 *
 * 飞书的坑：关键词 / 签名 / IP / 限流等错误都是 **HTTP 200 + code≠0**，
 * 只看 res.ok 会把失败当成功。
 */
export async function send(url, text, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!url) return { ok: false, reason: '未配置 webhook 地址' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = {};
    try { body = await res.json(); } catch { /* 非 JSON 响应当作没有业务码 */ }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, reason: `code ${body.code}${body.msg ? ` ${body.msg}` : ''}` };
    }
    return { ok: true, reason: '' };
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '请求超时' : (e?.message || '网络错误').split('\n')[0];
    return { ok: false, reason: why };
  }
}

export function loadState(path = STATE_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')) || {}; } catch { return {}; }
}

export function saveState(state, path = STATE_PATH) {
  try { writeFileSync(path, JSON.stringify(state, null, 2)); return true; } catch { return false; }
}

/**
 * 编排：读配置 → 判定 → 发送 → （成功后）记状态。
 * 调用方**必须 await**：主流程末尾是 process.exit，不会等未完成的 Promise。
 *
 * @returns {Promise<{pushed:boolean, reason:string, kind?:string}>}
 */
export async function pushResult({
  report, quiet, testWebhook = false,
  url, configPath, statePath = STATE_PATH,
  breakerEnabled, fetchImpl, today = todayKey(),
} = {}) {
  // 通知失败绝不影响签到：连这里自己意外抛错也要兜住。调用方紧接着就是
  // process.exit，一个未捕获的 rejection 会让整个收尾流程断在这里。
  try {
    const addr = url ?? readWebhookUrl(configPath);
    if (!addr) return { pushed: false, reason: '未配置 webhook，跳过' };

    const enabled = breakerEnabled ?? readBreakerEnabled(configPath);
    const state = loadState(statePath);
    const verdict = shouldPush(report, { quiet, testWebhook, breakerEnabled: enabled, state, today });
    if (!verdict.push) return { pushed: false, reason: '按规则不推送' };

    const r = await send(addr, buildText(report, verdict.kind), { fetchImpl });
    if (!r.ok) return { pushed: false, reason: r.reason };

    // 强制自检不占用「当天首个」名额；告警类只有发送成功才算推过
    if (verdict.kind === 'circuit' || verdict.kind === 'failure') {
      state[verdict.kind] = today;
      saveState(state, statePath);
    }
    return { pushed: true, reason: '', kind: verdict.kind };
  } catch (e) {
    return { pushed: false, reason: (e?.message || 'webhook 内部错误').split('\n')[0] };
  }
}
