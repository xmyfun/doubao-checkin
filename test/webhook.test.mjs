/**
 * 飞书 webhook：判定矩阵、发送、当天去重、失败重试。
 *
 * 红线：测试一律注入 fetchImpl 与临时路径，**绝不发真实网络请求**，
 * 也不读项目根的 config.conf（用户可能已经填了真实地址 / 改过阈值）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldPush, buildText, send, maskUrl, loadState, saveState, pushResult,
  readWebhookUrl, readBreakerEnabled, todayKey, parseTestArgs,
} from '../src/webhook.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef1234567890';
const TODAY = '2026-11-09';
const TOMORROW = '2026-11-10';

/** 每个用例独立的临时目录，避免用例间传状态 */
function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-webhook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ctx = (extra = {}) => ({ quiet: true, breakerEnabled: true, state: {}, today: TODAY, ...extra });
const r = (result, needs_attention = false) => ({ result, needs_attention, report: '说明文字' });

/** 造一个假的 fetch：记录调用、返回指定响应 */
function fakeFetch({ status = 200, body = { code: 0, msg: 'success' }, throws = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (throws) throw throws;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fn, calls };
}

// ── 判定矩阵 ──

test('手动运行一律不推：结果已经在终端里了', () => {
  for (const result of ['SUCCESS', 'CIRCUIT', 'FAIL', 'UNKNOWN', 'AUTH_FAIL', 'ALREADY', 'SKIPPED', 'BUSY']) {
    assert.equal(shouldPush(r(result), ctx({ quiet: false })).push, false, result);
    assert.equal(shouldPush(r(result), ctx({ quiet: false, breakerEnabled: false })).push, false, result);
  }
});

test('--test-webhook：任意结果都强推，且不受 quiet / 去重 / 熔断开关影响', () => {
  for (const result of ['SUCCESS', 'CIRCUIT', 'FAIL', 'UNKNOWN', 'AUTH_FAIL', 'ALREADY', 'SKIPPED', 'BUSY', 'PENDING']) {
    for (const quiet of [false, true]) {
      const v = shouldPush(r(result), ctx({ quiet, testWebhook: true, state: { circuit: TODAY, failure: TODAY } }));
      assert.equal(v.push, true, `${result} / quiet=${quiet}`);
      assert.equal(v.kind, 'test');
    }
  }
});

test('定时任务 + 熔断开启：SUCCESS 每次推，其余失败类一律不推', () => {
  assert.equal(shouldPush(r('SUCCESS'), ctx()).kind, 'success');
  for (const result of ['FAIL', 'UNKNOWN', 'AUTH_FAIL', 'ALREADY', 'SKIPPED', 'BUSY', 'PENDING', 'DOCTOR', 'REPAIR']) {
    assert.equal(shouldPush(r(result, true), ctx()).push, false, result);
  }
});

test('定时任务 + 熔断开启：当天首个 CIRCUIT 推，之后同日不再推', () => {
  assert.equal(shouldPush(r('CIRCUIT'), ctx()).kind, 'circuit');
  assert.equal(shouldPush(r('CIRCUIT'), ctx({ state: { circuit: TODAY } })).push, false);
  // 跨天重新放行
  assert.equal(shouldPush(r('CIRCUIT'), ctx({ state: { circuit: TODAY }, today: TOMORROW })).kind, 'circuit');
});

test('定时任务 + 熔断关闭（threshold=0）：改推当天首个失败类，不推 CIRCUIT', () => {
  const c = ctx({ breakerEnabled: false });
  assert.equal(shouldPush(r('FAIL', true), c).kind, 'failure');
  assert.equal(shouldPush(r('UNKNOWN', true), c).kind, 'failure');
  assert.equal(shouldPush(r('AUTH_FAIL', true), c).kind, 'failure');
  assert.equal(shouldPush(r('CIRCUIT'), c).push, false, '关掉熔断时不会有 CIRCUIT，即便有也不推');
  assert.equal(shouldPush(r('SUCCESS'), c).kind, 'success');
  assert.equal(shouldPush(r('ALREADY'), c).push, false);
  assert.equal(shouldPush(r('BUSY'), c).push, false);
});

test('熔断关闭时「每天首个」按天去重，且两种告警互不干扰', () => {
  assert.equal(shouldPush(r('FAIL', true), ctx({ breakerEnabled: false, state: { failure: TODAY } })).push, false);
  assert.equal(shouldPush(r('FAIL', true), ctx({ breakerEnabled: false, state: { failure: TODAY }, today: TOMORROW })).push, true);
  // 桌面弹窗 / 上一次熔断的名额不该静音失败告警
  assert.equal(shouldPush(r('FAIL', true), ctx({ breakerEnabled: false, state: { circuit: TODAY } })).push, true);
});

// ── 发送 ──

test('send：HTTP 200 + code 0 才算成功，请求体是飞书文本格式', async () => {
  const { fn, calls } = fakeFetch();
  const out = await send(URL, '一条消息', { fetchImpl: fn });
  assert.equal(out.ok, true);
  assert.equal(out.reason, '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    msg_type: 'text', content: { text: '一条消息' },
  });
});

test('send：飞书业务错误是 HTTP 200 + 非 0 code，不能只看 res.ok', async () => {
  for (const [code, msg] of [[9499, 'Bad Request'], [19024, 'Key Words Not Found'], [19021, 'sign match fail'], [11232, 'frequency limited']]) {
    const { fn } = fakeFetch({ body: { code, msg } });
    const out = await send(URL, 'x', { fetchImpl: fn });
    assert.equal(out.ok, false, `code ${code} 应判失败`);
    assert.match(out.reason, new RegExp(String(code)));
  }
});

test('send：非 2xx / 超时 / 网络异常都返回失败而不是抛', async () => {
  assert.equal((await send(URL, 'x', { fetchImpl: fakeFetch({ status: 500 }).fn })).ok, false);
  const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  assert.equal((await send(URL, 'x', { fetchImpl: fakeFetch({ throws: timeout }).fn })).ok, false);
  assert.equal((await send(URL, 'x', { fetchImpl: fakeFetch({ throws: new Error('ENOTFOUND') }).fn })).ok, false);
  assert.equal((await send('', 'x', { fetchImpl: fakeFetch().fn })).ok, false);
});

test('send：非 JSON 响应不崩，按 HTTP 状态判定', async () => {
  const fn = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
  assert.equal((await send(URL, 'x', { fetchImpl: fn })).ok, true);
});

// ── 编排 ──

test('pushResult：没配地址时直接跳过，绝不发网络请求', async (t) => {
  const dir = freshDir(t);
  const { fn, calls } = fakeFetch();
  const out = await pushResult({
    report: r('SUCCESS'), quiet: true, testWebhook: true,
    configPath: join(dir, 'nope.conf'), statePath: join(dir, 'state.json'),
    breakerEnabled: true, fetchImpl: fn,
  });
  assert.equal(out.pushed, false);
  assert.equal(calls.length, 0);
});

test('pushResult：推送成功后写状态，同日同类型不再推', async (t) => {
  const dir = freshDir(t);
  const statePath = join(dir, 'state.json');
  const { fn, calls } = fakeFetch();
  const base = {
    url: URL, configPath: join(dir, 'nope.conf'), statePath,
    breakerEnabled: true, fetchImpl: fn, today: TODAY,
  };

  const first = await pushResult({ ...base, report: r('CIRCUIT'), quiet: true });
  assert.equal(first.pushed, true);
  assert.equal(first.kind, 'circuit');
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { circuit: TODAY });

  const second = await pushResult({ ...base, report: r('CIRCUIT'), quiet: true });
  assert.equal(second.pushed, false);
  assert.equal(calls.length, 1, '去重后不该再发一次');
});

test('pushResult：发送失败不写状态，下次运行仍算当天首个（自动重试）', async (t) => {
  const dir = freshDir(t);
  const statePath = join(dir, 'state.json');
  const bad = { fn: fakeFetch({ body: { code: 19024, msg: 'Key Words Not Found' } }).fn, calls: [] };
  const base = {
    url: URL, configPath: join(dir, 'nope.conf'), statePath,
    breakerEnabled: false, today: TODAY,
  };

  const first = await pushResult({ ...base, report: r('FAIL', true), quiet: true, fetchImpl: bad.fn });
  assert.equal(first.pushed, false);
  assert.equal(existsSync(statePath), false, '失败绝不占掉当天名额');

  const { fn: good, calls } = fakeFetch();
  const second = await pushResult({ ...base, report: r('FAIL', true), quiet: true, fetchImpl: good });
  assert.equal(second.pushed, true);
  assert.equal(calls.length, 1);
});

test('pushResult：内部意外抛错也不冒泡（调用方紧接着 process.exit）', async (t) => {
  const dir = freshDir(t);
  const evil = { get result() { throw new Error('结果对象坏了'); } };
  const { fn, calls } = fakeFetch();
  const out = await pushResult({
    report: evil, quiet: true, url: URL, configPath: join(dir, 'nope.conf'),
    statePath: join(dir, 'state.json'), breakerEnabled: true, fetchImpl: fn,
  });
  assert.equal(out.pushed, false);
  assert.match(out.reason, /结果对象坏了/);
  assert.equal(calls.length, 0);
});

test('pushResult：--test-webhook 强推且不占当天名额', async (t) => {
  const dir = freshDir(t);
  const statePath = join(dir, 'state.json');
  const { fn, calls } = fakeFetch();
  const base = { url: URL, configPath: join(dir, 'nope.conf'), statePath, breakerEnabled: true, fetchImpl: fn, today: TODAY };

  assert.equal((await pushResult({ ...base, report: r('SKIPPED'), quiet: false, testWebhook: true })).kind, 'test');
  assert.equal(existsSync(statePath), false, '自检不该写告警状态');
  assert.equal(calls.length, 1);
});

// ── 辅助 ──

test('buildText：带固定关键词、含结果与时间、超长会截断', () => {
  const text = buildText({ result: 'SUCCESS', report: '签到成功', client: { version: '2.34.6' } }, 'success',
    { now: new Date(2026, 10, 9, 3, 33) });
  assert.match(text, /豆包签到/);
  assert.match(text, /SUCCESS/);
  assert.match(text, /2026-11-09 03:33/);
  assert.match(text, /2\.34\.6/);
  assert.ok(buildText({ report: 'x'.repeat(9000) }, 'failure').length <= 4000);
});

test('buildText install：含安装完成 / 主机名 / 脚本绝对路径，不带签到结果', () => {
  const text = buildText({}, 'install', {
    now: new Date(2026, 10, 9, 8, 12),
    host: 'studio-mac',
    scriptPath: '/tmp/doubao-checkin/scripts/doubao-checkin.sh',
  });
  assert.match(text, /豆包签到/);
  assert.match(text, /2026-11-09 08:12 · 定时任务安装完成/);
  assert.match(text, /主机  studio-mac/);
  assert.match(text, /脚本  \/tmp\/doubao-checkin\/scripts\/doubao-checkin\.sh/);
  assert.ok(!text.includes('结果 '), '安装自检不该带某次签到的结果行');
});

test('buildText test：--test-webhook 强推要带上本次结果', () => {
  const text = buildText({ result: 'SKIPPED', report: '今日已签到，本次跳过' }, 'test');
  assert.match(text, /SKIPPED/);
  assert.match(text, /今日已签到，本次跳过/);
});

test('parseTestArgs：--url / --script / --host 的等号与空格写法', () => {
  assert.deepEqual(
    parseTestArgs(['--url=https://example.com/hook/a', '--script=/tmp/a/doubao-checkin.sh', '--host=mac']),
    { url: 'https://example.com/hook/a', scriptPath: '/tmp/a/doubao-checkin.sh', host: 'mac', error: '' },
  );
  assert.deepEqual(
    parseTestArgs(['--url', 'https://example.com/hook/a']),
    { url: 'https://example.com/hook/a', scriptPath: '', host: '', error: '' },
  );
  assert.deepEqual(parseTestArgs([]), { url: '', scriptPath: '', host: '', error: '' });
});

test('parseTestArgs：空值 / 非地址 / 未知参数都明确报错，不静默发请求', () => {
  assert.match(parseTestArgs(['--url=']).error, /不能为空/);
  assert.match(parseTestArgs(['--url']).error, /后面要跟/);
  assert.match(parseTestArgs(['--url', '--host=x']).error, /后面要跟/);
  assert.match(parseTestArgs(['--url=abc']).error, /http\(s\):\/\//);
  assert.match(parseTestArgs(['--bogus']).error, /未知参数/);
});

test('maskUrl：只留 host 与末 4 位，绝不泄露完整地址', () => {
  const masked = maskUrl(URL);
  assert.ok(masked.includes('open.feishu.cn'));
  assert.ok(!masked.includes('abcdef1234567890'));
});

test('readWebhookUrl / readBreakerEnabled：从指定配置文件读，缺省按「未启用 / 开启熔断」', (t) => {
  const dir = freshDir(t);
  const path = join(dir, 'config.conf');
  writeFileSync(path, '# 注释\nnotify.feishuWebhook = https://example.com/hook/xyz\nbreaker.threshold = 0\n');
  assert.equal(readWebhookUrl(path), 'https://example.com/hook/xyz');
  assert.equal(readBreakerEnabled(path), false);

  writeFileSync(path, 'notify.feishuWebhook =\nbreaker.threshold = 3\n');
  assert.equal(readWebhookUrl(path), '');
  assert.equal(readBreakerEnabled(path), true);

  assert.equal(readWebhookUrl(join(dir, 'missing.conf')), '');
  assert.equal(readBreakerEnabled(join(dir, 'missing.conf')), true);
});

test('状态文件损坏 / 写不了都不抛', (t) => {
  const dir = freshDir(t);
  const path = join(dir, 'state.json');
  writeFileSync(path, '{ 坏掉的 json');
  assert.deepEqual(loadState(path), {});
  assert.deepEqual(loadState(join(dir, 'missing.json')), {});
  assert.equal(saveState({ circuit: TODAY }, path), true);
  assert.equal(loadState(path).circuit, TODAY);
  assert.equal(saveState({}, join(dir, 'no/such/dir/state.json')), false);
});

test('todayKey 是本地日期，格式 YYYY-MM-DD', () => {
  assert.match(todayKey(new Date(2026, 10, 9)), /^2026-11-09$/);
  assert.equal(todayKey(new Date(2026, 0, 5)), '2026-01-05');
});
