/**
 * 配置：内嵌模板（唯一事实来源）+ 解析 + 生成 config.conf
 *
 * **术语约定**：这份文件里说的「模板」一律指 `src/config-template.mjs` 导出的
 * 常量 `CONFIG_TEMPLATE`，**不是**仓库根目录那个 `config.conf.example`。后者只是
 * 同一份内容的可读副本（给用户复制改名的），可能被改名、也可能被删掉 —— 运行期
 * 没有任何代码读它。
 *
 * 设计原则
 *   1. 注释和默认值都只在**代码里的那份模板常量**中写一次：生成 `config.conf` 时
 *      逐字照搬，不重新组织语言。
 *   2. schema 只描述"这一项是什么类型、允许的范围"，不再重复写默认值和注释
 *   3. 写错一项只影响那一项：打警告、退回默认值、继续跑
 *   4. 优先级：命令行 > config.conf > 模板里的默认值
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG_TEMPLATE } from './config-template.mjs';

export { CONFIG_TEMPLATE };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(ROOT, 'config.conf');
/** 仓库里那份可读的模板副本。**只给测试用**（校验磁盘副本与内嵌常量一致），
 *  运行期任何代码都不读它 —— 它随时可能被改名/删除。 */
export const CONFIG_TEMPLATE_PATH = join(ROOT, 'config.conf.example');

// ── 解析 ──

/** 解析 "key = value" 明文；返回 { values, bad } */
export function parseConf(text) {
  const values = {};
  const bad = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) { bad.push(line); continue; }
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!key) { bad.push(line); continue; }
    values[key] = val;
  }
  return { values, bad };
}

function coerce(raw, item) {
  if (item.kind === 'bool') {
    const v = raw.toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(v)) return true;
    if (['false', 'no', '0', 'off'].includes(v)) return false;
    return undefined;
  }
  if (item.kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(item.max ?? Infinity, Math.max(item.min ?? -Infinity, n));
  }
  return raw; // path / 文本
}

// ── 配置项 ──
//
// 只写"类型 + 范围"。默认值和说明文字全在内嵌模板（CONFIG_TEMPLATE）里，
// 两处各写一份必然对不上（注释里写着「默认值：2」，代码里却是 1）。

export const SCHEMA = [
  { key: 'nodePath', kind: 'path' },
  { key: 'autoInstallNode', kind: 'bool' },
  { key: 'appPath', kind: 'path' },
  { key: 'cdpPort', kind: 'number', min: 1024, max: 65535 },

  { key: 'logDir', kind: 'path' },

  // 定时任务的时间。**运行时不消费**，只有 scripts/install-launchd.sh 读它生成 plist
  // —— 所以这里不做格式校验（HH:MM 的解析和报错都在那个脚本里，它才是唯一消费者）。
  // 放进 SCHEMA 是为了 renderConf 能生成这几行、以及不被当成"不认识的项"警告。
  { key: 'schedule.times', kind: 'text' },
  { key: 'schedule.runAtLoad', kind: 'bool' },
  { key: 'schedule.intervalSeconds', kind: 'number', min: 0, max: 86400 },

  { key: 'allowRelaunch', kind: 'bool' },

  { key: 'busyCheck.enabled', kind: 'bool' },
  { key: 'busyCheck.windowSeconds', kind: 'number', min: 5, max: 300 },
  { key: 'busyCheck.sampleSeconds', kind: 'number', min: 1, max: 30 },
  { key: 'busyCheck.cpuThreshold', kind: 'number', min: 0.01, max: 16 },
  { key: 'busyCheck.netInKBps', kind: 'number', min: 0.01, max: 10000 },

  // 0 = 关闭熔断
  { key: 'breaker.threshold', kind: 'number', min: 0, max: 100 },
  { key: 'breaker.cooldownHours', kind: 'number', min: 0, max: 8760 },

  // 0 = 不去抖（每次失败都弹）
  { key: 'notify.debounceHours', kind: 'number', min: 0, max: 8760 },

  // 空 = 不启用。真实地址只写进 config.conf，绝不进仓库
  { key: 'notify.feishuWebhook', kind: 'text' },
];

/** { 'busyCheck.enabled': item, ... } */
export const ITEMS = new Map(SCHEMA.map((it) => [it.key, it]));

// 默认值从模板解析出来，并回填到 item.default（警告文案要用它）
// 模板缺项或值写错都是**开发期错误**，直接抛，别等到线上悄悄用错默认值。
const TEMPLATE_VALUES = parseConf(CONFIG_TEMPLATE).values;
for (const it of SCHEMA) {
  if (!(it.key in TEMPLATE_VALUES)) {
    throw new Error(`内置模板（src/config-template.mjs）里没有 ${it.key} —— SCHEMA 与模板必须一一对应`);
  }
  const v = coerce(TEMPLATE_VALUES[it.key], it);
  if (v === undefined) {
    throw new Error(`内置模板里 ${it.key} = ${TEMPLATE_VALUES[it.key]} 无法按 ${it.kind} 解析`);
  }
  it.default = v;
}

export const DEFAULTS = (() => {
  // 空对象起步，分组由 ??= 按需创建 —— 加了 breaker / schedule 之后再写死
  // busyCheck 就会漏建另外两组。
  const o = {};
  for (const [key, it] of ITEMS) {
    if (key.includes('.')) {
      const [head, tail] = key.split('.');
      o[head] ??= {};
      o[head][tail] = it.default;
    } else o[key] = it.default;
  }
  return o;
})();

/** 生成默认对象（深拷贝） */
export function defaultPrefs() {
  return structuredClone(DEFAULTS);
}

function getPath(obj, key) {
  if (!key.includes('.')) return obj?.[key];
  const [head, tail] = key.split('.');
  return obj?.[head]?.[tail];
}

// ── 读取 ──

/**
 * @param {{ allowRelaunch?: boolean }} cli 命令行显式指定的项
 * @param {{ configPath?: string }} opts
 *   configPath 只给测试用：不传就读项目根的 config.conf。
 *   测试必须传一个空路径，否则会读到开发者/用户真实的配置 ——
 *   用户把 cpuThreshold 调成 0.9 之后，「没有配置文件时用默认值」那条测试就红了，
 *   报错是 0.9 !== 0.35，看上去像代码坏了。
 */
export async function loadSettings(cli = {}, opts = {}) {
  const warnings = [];
  const prefs = defaultPrefs();
  const path = opts.configPath || CONFIG_PATH;

  if (!existsSync(path)) {
    // 没有配置文件是**正常情况**，直接用默认值，不打扰用户
    if (typeof cli.allowRelaunch === 'boolean') prefs.allowRelaunch = cli.allowRelaunch;
    return { prefs, warnings };
  }

  let parsed;
  try {
    parsed = parseConf(readFileSync(path, 'utf8'));
  } catch (e) {
    warnings.push(`config.conf 读取失败（${e.message.split('\n')[0]}），使用默认值`);
    parsed = { values: {}, bad: [] };
  }

  for (const l of parsed.bad) warnings.push(`config.conf 有一行没看懂，已忽略：${l.slice(0, 40)}`);

  for (const [key, raw] of Object.entries(parsed.values)) {
    const item = ITEMS.get(key);
    if (!item) { warnings.push(`config.conf 里的 ${key} 不认识，已忽略`); continue; }
    const v = coerce(raw, item);
    if (v === undefined) {
      const hint = item.kind === 'bool' ? '只能是 true / false' : '不是合法数字';
      warnings.push(`${key}（${hint}），已忽略，使用默认值 ${JSON.stringify(item.default)}`);
      continue;
    }
    if (item.kind === 'number' && v !== Number(raw)) {
      warnings.push(`${key}=${raw} 超出范围 ${item.min}~${item.max}，已按 ${v} 处理`);
    }
    if (key.includes('.')) {
      const [head, tail] = key.split('.');
      prefs[head][tail] = v;
    } else prefs[key] = v;
  }

  if (typeof cli.allowRelaunch === 'boolean') prefs.allowRelaunch = cli.allowRelaunch;

  // 窗口至少要有 3 个样本，否则中位数没意义
  const bc = prefs.busyCheck;
  if (bc.windowSeconds < bc.sampleSeconds * 3) {
    const fixed = bc.sampleSeconds * 3;
    warnings.push(`busyCheck.windowSeconds(${bc.windowSeconds}) 太小，至少要有 3 个样本，已按 ${fixed} 秒处理`);
    bc.windowSeconds = fixed;
  }

  return { prefs, warnings };
}

// ── 生成 ──

function fmt(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === '' || v === null || v === undefined) return '';
  return String(v);
}

/**
 * 生成完整的 config.conf：**内嵌模板原文 + 当前值**（不读磁盘上的 .template）。
 * 注释一个字都不改写 —— 用户读懂配置全靠它们，脚本没有资格重新组织语言。
 */
export function renderConf(prefs = defaultPrefs()) {
  let out = CONFIG_TEMPLATE;
  for (const key of ITEMS.keys()) {
    const v = getPath(prefs, key);
    if (v === undefined) continue;
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(${esc}[ \\t]*=)[^\\n]*$`, 'm');
    if (!re.test(out)) throw new Error(`内置配置模板（config-template.mjs）里没有 ${key} 这一行`);
    const val = fmt(v);
    // 空值写成 `key =`（不留行尾空格），有值写成 `key = 值`
    out = out.replace(re, (_m, head) => (val === '' ? head.trimEnd() : `${head} ${val}`));
  }
  return out;
}

/** 按默认值生成一份 config.conf；已有文件不覆盖（除非 force） */
export function createConf({ prefs = defaultPrefs(), force = false, path = CONFIG_PATH } = {}) {
  if (existsSync(path) && !force) return { ok: false, existed: true, path };
  try {
    writeFileSync(path, renderConf(prefs));
    return { ok: true, existed: false, path };
  } catch (e) {
    return { ok: false, existed: true, path, reason: e.message.split('\n')[0] };
  }
}

// ── 就地改写 ──

/**
 * 读一项的原始字符串值。读不到返回空串（不抛）。
 * 和 loadSettings 的区别：这里不做类型转换、不打警告，只给"当前文件里写的是什么"。
 */
export function readConfKey(key, path = CONFIG_PATH) {
  try {
    return parseConf(readFileSync(path, 'utf8')).values[key] ?? '';
  } catch { return ''; }
}

/**
 * 就地改写 config.conf 里的一项：有这一行就换值，没有就追加到末尾。
 *
 * **只换 value，行首缩进和行尾注释都留着** —— config.conf 里那些解释性注释是
 * 用户理解配置的唯一途径，自动化改写把它们冲掉是最容易犯的错。
 *
 * 为什么还要校验行数：正则写错会把多行吞成一行，那种损坏很难被发现。
 * 行数变少就放弃写入，返回失败让调用方去说。
 *
 * @returns {{ok: boolean, created?: boolean, reason?: string}}
 *
 * 注意：scripts/install-launchd.sh 里有一份 awk 实现的 conf_set 做同样的事
 * （shell 里没法 import 这个模块）。两边的规则必须一致，改这里要同步那边。
 */
export function upsertConfKey(key, value, path = CONFIG_PATH) {
  const exists = existsSync(path);
  let text = '';
  try {
    if (exists) text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `读不了 ${path}（${e.message.split('\n')[0]}）` };
  }

  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 分三种情况，顺序不能颠倒：
  //   1. 有行尾注释 → 只换值，缩进和注释原样留住（注释右边通常就写着这项是干什么的）
  //   2. 没有注释   → 只换值
  //   3. 压根没这行 → 追加到末尾
  const reWithComment = new RegExp(`^(\\s*)${esc}[ \\t]*=[^#\\n]*?([ \\t]+#.*)$`, 'm');
  const rePlain = new RegExp(`^(\\s*)${esc}[ \\t]*=.*$`, 'm');

  let out;
  if (reWithComment.test(text)) {
    out = text.replace(reWithComment, (_m, indent, tail) => `${indent}${key} = ${value}${tail}`);
  } else if (rePlain.test(text)) {
    out = text.replace(rePlain, (_m, indent) => `${indent}${key} = ${value}`);
  } else {
    const body = text.replace(/\n*$/, '');
    out = body ? `${body}\n${key} = ${value}\n` : `${key} = ${value}\n`;
  }

  if (out.split('\n').length < text.split('\n').length) {
    return { ok: false, reason: '改写后行数变少，已放弃（可能是正则匹配范围过大）' };
  }

  try {
    writeFileSync(path, out);
  } catch (e) {
    return { ok: false, reason: `写不了 ${path}（${e.message.split('\n')[0]}）` };
  }
  return { ok: true, created: !exists };
}
