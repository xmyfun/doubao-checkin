/**
 * install-launchd.sh 的「未配置 webhook 时交互询问」分支。
 *
 * 为什么抽函数而不是跑整脚本：装脚本会动 ~/Library/LaunchAgents、调 launchctl、
 * 还会因 RunAtLoad 真跑一次签到，测试环境里既不该也不便做这些事。
 * 这里把脚本里**真实的** conf_get / conf_set / prompt_webhook 三个函数体按函数名
 * 抽出来，放进临时目录的 bash 里执行 —— 判定与写盘逻辑仍是产品代码，不是复刻版。
 * 桩只提供 PROJECT_DIR / DRY / WEBHOOK_URL_ARG 和三个颜色函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SH_PATH = join(ROOT, 'scripts/install-launchd.sh');
const SH = readFileSync(SH_PATH, 'utf8');

/** 抽一个 shell 函数：从 `name() {` 到下一个行首 `}`（函数体内没有行首的 }）。 */
function extractFn(name) {
  const lines = SH.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `install-launchd.sh 里找不到 ${name}() {`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.notEqual(end, -1, `${name}() 没找到行首的结束 }`);
  return lines.slice(start, end + 1).join('\n');
}

const HELPERS = ['conf_get', 'conf_set', 'prompt_webhook'].map(extractFn).join('\n\n');

const URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-token-0001';
const BASE_CONF = [
  '# 一份最小配置（测试用）',
  'cdpPort = 9225',
  'allowRelaunch = true   # 行尾注释要保留',
  'notify.debounceHours = 6',
  'notify.feishuWebhook =',
  '',
].join('\n');

const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function run({ conf = BASE_CONF, input = '', dry = 0, urlArg = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-launchd-'));
  try {
    if (conf !== null) writeFileSync(join(dir, 'config.conf'), conf);
    const wrapper = [
      'set -euo pipefail',
      `PROJECT_DIR=${sq(dir)}`,
      `DRY=${dry}`,
      `WEBHOOK_URL_ARG=${sq(urlArg)}`,
      'red()   { printf "RED   | %s\\n" "$*"; }',
      'green() { printf "GREEN | %s\\n" "$*"; }',
      'yellow(){ printf "YELLOW| %s\\n" "$*"; }',
      HELPERS,
      'prompt_webhook',
      'echo "READBACK:$(conf_get notify.feishuWebhook)"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', wrapper], { input, encoding: 'utf8', cwd: dir });
    const confPath = join(dir, 'config.conf');
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      status: r.status,
      after: existsSync(confPath) ? readFileSync(confPath, 'utf8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('install-launchd.sh 通过 bash -n', () => {
  const r = spawnSync('bash', ['-n', SH_PATH], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('未配置 + 输入地址 → 写进 config.conf，其余配置与注释原样保留', () => {
  const r = run({ input: `${URL}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已写入 config\.conf/);
  assert.ok(r.after.includes(`notify.feishuWebhook = ${URL}`), r.after);
  assert.ok(r.after.includes('allowRelaunch = true   # 行尾注释要保留'));
  assert.equal(r.after.split('\n').length, BASE_CONF.split('\n').length, '行数不该变化');
  assert.ok(r.stdout.includes(`READBACK:${URL}`), 'conf_set 写进去的值必须能被 conf_get 读回来');
});

test('未配置 + 直接回车 → 跳过，config.conf 一个字都不改', () => {
  const r = run({ input: '\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已跳过飞书通知配置/);
  assert.equal(r.after, BASE_CONF);
});

test('已配置 → 不问，也不会被 stdin 里的另一个地址覆盖', () => {
  const conf = BASE_CONF.replace(
    'notify.feishuWebhook =',
    'notify.feishuWebhook = https://example.com/hook/old',
  );
  const r = run({ conf, input: `${URL}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /现在可以直接配置/);
  assert.equal(r.after, conf);
});

test('非交互（stdin 直接 EOF）→ 跳过且不卡住', () => {
  const r = run({ input: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /读不到输入/);
  assert.equal(r.after, BASE_CONF);
});

test('非法地址先提示重问，回车后跳过，不写半个地址进去', () => {
  const r = run({ input: 'ftp://example.com/hook\n\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /要以 http/);
  assert.match(r.stdout, /已跳过/);
  assert.equal(r.after, BASE_CONF);
});

test('带 --test-webhook=<地址> → 不问（非交互安装专用入口）', () => {
  const r = run({ urlArg: URL, input: `${URL}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /现在可以直接配置/);
  assert.equal(r.after, BASE_CONF);
});

test('--dry-run → 不问、不写', () => {
  const r = run({ dry: 1, input: `${URL}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /现在可以直接配置/);
  assert.equal(r.after, BASE_CONF);
});

test('config.conf 不存在 → 输入地址会创建文件并写入', () => {
  const r = run({ conf: null, input: `${URL}\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /已写入 config\.conf/);
  assert.equal(r.after, `notify.feishuWebhook = ${URL}\n`);
});

test('地址里的 & ? = 原样写入，首尾空白被去掉', () => {
  const fancy = `${URL}?a=1&b=2`;
  const r = run({ input: `  ${fancy}  \n` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`READBACK:${fancy}`), 'awk -v 不该吃掉 & 或 =');
  assert.ok(r.after.includes(`notify.feishuWebhook = ${fancy}`));
});

test('含 # / 引号 / 反斜杠的输入被拒绝，避免写进去的值与用户粘贴的不一致', () => {
  for (const bad of [`${URL}#frag`, `  ${URL} x`, `${URL}\\n`]) {
    const r = run({ input: `${bad}\n\n` });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /请重新粘贴/);
    assert.equal(r.after, BASE_CONF);
  }
});
