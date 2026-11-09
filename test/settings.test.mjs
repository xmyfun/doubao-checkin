/**
 * 配置模板与代码的同步护栏。
 *
 * 这层为什么要测：`config.conf` 的注释是用户理解配置的唯一途径，而默认值写错
 * （或注释里写着 2、代码里是 1）不会报错、只会"行为跟说明不一致"，
 * 这种错最难被发现。所以把三件事锁住：
 *   · 磁盘上的 config.conf.example 与 src/config-template.mjs 的常量一致
 *   · DEFAULTS 就是模板解析出来的值（不是另写的一份）
 *   · renderConf 只替换值，注释一个字都不动
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONFIG_TEMPLATE, ITEMS, DEFAULTS, defaultPrefs, parseConf, renderConf, createConf, loadSettings,
} from '../src/settings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = join(ROOT, 'config.conf.example');

/** 忽略行尾空白（编辑器会 trim，不该因此判失败） */
const norm = (s) => s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');

test('磁盘上的 config.conf.example 与代码里的 CONFIG_TEMPLATE 一致', (t) => {
  if (!existsSync(TEMPLATE_PATH)) {
    // 用户按 README 把它改名成 config.conf 了，属于正常情况
    t.skip('config.conf.example 已被改名，跳过');
    return;
  }
  assert.equal(norm(readFileSync(TEMPLATE_PATH, 'utf8')), norm(CONFIG_TEMPLATE),
    '模板文件改过但没有同步到 src/config-template.mjs（或反过来）');
});

test('模板里每一项都在 schema 里，schema 每一项也都在模板里', () => {
  const keys = Object.keys(parseConf(CONFIG_TEMPLATE).values);
  assert.deepEqual([...keys].sort(), [...ITEMS.keys()].sort(),
    'config.conf.example 与 src/settings.mjs 的 SCHEMA 必须一一对应');
});

test('默认值就是模板里写的值', () => {
  assert.equal(DEFAULTS.autoInstallNode, true);
  assert.equal(DEFAULTS.appPath, '/Applications/Doubao.app');
  assert.equal(DEFAULTS.cdpPort, 9225);
  assert.equal(DEFAULTS.nodePath, '');
  assert.equal(DEFAULTS.logDir, '');
  assert.equal(DEFAULTS.notify.feishuWebhook, '', 'webhook 默认留空 = 不启用');
  assert.equal(DEFAULTS.allowRelaunch, true);
  assert.deepEqual(DEFAULTS.busyCheck, {
    enabled: true, windowSeconds: 30, sampleSeconds: 3, cpuThreshold: 0.35, netInKBps: 3,
  }, 'busyCheck 的默认值必须和模板一致（改模板就等于改默认值）');
});

test('默认值按类型解析，不是一堆字符串', () => {
  assert.equal(typeof DEFAULTS.cdpPort, 'number');
  assert.equal(typeof DEFAULTS.busyCheck.cpuThreshold, 'number');
  assert.equal(typeof DEFAULTS.allowRelaunch, 'boolean');
});

test('renderConf 默认值 = 模板原文（只差行尾空白）', () => {
  assert.equal(norm(renderConf()), norm(CONFIG_TEMPLATE));
});

test('renderConf 只换值：注释和空行一个字都不动', () => {
  const p = defaultPrefs();
  p.nodePath = '/opt/homebrew/bin/node';
  p.logDir = '/tmp/dc-logs';
  p.allowRelaunch = false;
  p.busyCheck.cpuThreshold = 0.2;
  const out = renderConf(p);

  const before = CONFIG_TEMPLATE.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length, '行数变了，说明注释被吞或被多插了');
  for (let i = 0; i < before.length; i++) {
    if (before[i].startsWith('#')) assert.equal(after[i], before[i], `第 ${i + 1} 行注释被改动了`);
  }
});

test('renderConf 生成的文件能被自己解析回去', () => {
  const p = defaultPrefs();
  p.appPath = '/Applications/Custom.app';
  p.busyCheck.windowSeconds = 45;
  p.busyCheck.netInKBps = 3.5;
  const v = parseConf(renderConf(p)).values;
  assert.equal(v.appPath, '/Applications/Custom.app');
  assert.equal(v['busyCheck.windowSeconds'], '45');
  assert.equal(v['busyCheck.netInKBps'], '3.5');
  assert.equal(v.allowRelaunch, 'true');
});

test('renderConf 对空字符串写成 `key =`，不留行尾空格', () => {
  const out = renderConf();
  assert.ok(out.includes('\nnodePath =\n'), 'nodePath 空值应写成 `nodePath =`');
  assert.doesNotMatch(out, /nodePath = +\n/);
  assert.doesNotMatch(out, /logDir = +\n/);
});

test('createConf：没有文件时生成，内容与模板一致', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-conf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.conf');
  const r = createConf({ path });
  assert.equal(r.ok, true);
  assert.equal(r.existed, false);
  assert.equal(norm(readFileSync(path, 'utf8')), norm(CONFIG_TEMPLATE));
});

test('createConf：已存在就绝不覆盖用户改过的值', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-conf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.conf');
  writeFileSync(path, 'cdpPort = 9300\n');
  const r = createConf({ path });
  assert.equal(r.ok, false);
  assert.equal(r.existed, true);
  assert.equal(readFileSync(path, 'utf8'), 'cdpPort = 9300\n');
});

// --create-config 不能依赖磁盘上的 config.conf.example：那个文件随时可能不在
// （用户按 README 改名成 config.conf 了，或作者删了）。生成必须只靠代码里的常量。
// 这里把 src/ 整个搬到临时目录当作一个"模板文件缺失的项目"，再走一遍生成。
test('createConf：磁盘上没有 config.conf.example 也能生成（不依赖它）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-ghost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  assert.equal(existsSync(join(dir, 'config.conf.example')), false, '前置条件：临时项目里没有模板文件');

  const mod = await import(pathToFileURL(join(dir, 'src', 'settings.mjs')).href);
  const r = mod.createConf();

  assert.equal(r.ok, true, `模板缺失时生成失败了：${r.reason || ''}`);
  // macOS 的 tmpdir 是 /var → /private/var 的软链，比较前先取真实路径
  assert.equal(realpathSync(r.path), join(realpathSync(dir), 'config.conf'));
  assert.equal(norm(readFileSync(join(dir, 'config.conf'), 'utf8')), norm(CONFIG_TEMPLATE));
  assert.equal(existsSync(join(dir, 'config.conf.example')), false, '生成过程不该凭空造出模板文件');
});

// ── loadSettings：读配置 + 纠错 ──
//
// 每条都显式传 configPath（指向临时文件），绝不读项目根的 config.conf ——
// 否则断言的是"跑测试这台机器当前的配置"，用户改过阈值就会红。

/** 造一个只有指定内容的 config.conf，返回它的路径 */
function confWith(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-load-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.conf');
  writeFileSync(path, text);
  return path;
}

test('loadSettings：没有配置文件时用内置默认值，且不报警告', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-load-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { prefs, warnings } = await loadSettings({}, { configPath: join(dir, 'nope.conf') });
  assert.equal(prefs.busyCheck.cpuThreshold, DEFAULTS.busyCheck.cpuThreshold);
  assert.deepEqual(warnings, [], '没有配置文件是正常情况，不该出现警告');
});

test('loadSettings：窗口小到凑不出 3 个样本时会被抬上去，并说明原因', async (t) => {
  const path = confWith(t, 'busyCheck.sampleSeconds = 3\nbusyCheck.windowSeconds = 3\n');
  const { prefs, warnings } = await loadSettings({}, { configPath: path });
  assert.equal(prefs.busyCheck.windowSeconds, 9, '3 秒采样至少要 9 秒窗口才够 3 个样本');
  assert.ok(warnings.some((w) => w.includes('windowSeconds')), `应当提示窗口被抬起：${warnings.join(' / ')}`);
});

test('loadSettings：命令行显式指定的值优先于文件', async (t) => {
  const path = confWith(t, 'allowRelaunch = false\n');
  const { prefs } = await loadSettings({ allowRelaunch: true }, { configPath: path });
  assert.equal(prefs.allowRelaunch, true);
});

test('loadSettings：非法值回落到默认值并给警告，其他项照常生效', async (t) => {
  const path = confWith(t, 'cdpPort = 不是数字\nallowRelaunch = false\n');
  const { prefs, warnings } = await loadSettings({}, { configPath: path });
  assert.equal(prefs.cdpPort, DEFAULTS.cdpPort, '非法端口应回落默认值');
  assert.equal(prefs.allowRelaunch, false, '同一份文件里的合法项不能被牵连');
  assert.ok(warnings.some((w) => w.includes('cdpPort')), `应当提示 cdpPort 被忽略：${warnings.join(' / ')}`);
});

