/**
 * 连续失败熔断。
 *
 * 钉住的是「什么算连续失败」这个判定 —— 全项目唯一会**主动停工**的逻辑，
 * 判错两个方向的代价不对称：
 *   太松 → 页面改版后每小时启动一次客户端再强杀，2026-10-30 那次连续 31 小时
 *          就是这么攒出来的（30 条 UNKNOWN，每次以 SIGKILL 收尾）；
 *   太紧 → 一次网络抖动就停工一整天，等于没装。
 *
 * 输入是 readHistory() 的输出：**新的在前**。这一点很关键，反过来写会把
 * "最近一次成功"当成"最早一次成功"，计数全错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakerState } from '../src/breaker.mjs';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);   // 2026-10-31 12:00 UTC

/** 造一条记录：minutesAgo 分钟之前发生的 */
const row = (result, minutesAgo = 0) => ({
  result,
  at: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

const opts = { threshold: 3, cooldownHours: 12, now: NOW };

test('失败次数不到阈值：放行', () => {
  const r = breakerState([row('UNKNOWN', 0), row('UNKNOWN', 60)], opts);
  assert.equal(r.tripped, false);
  assert.equal(r.fails, 2);
  assert.equal(r.probe, false);
});

test('连续失败达到阈值：熔断，并给出放行时间', () => {
  const r = breakerState([row('UNKNOWN', 0), row('UNKNOWN', 60), row('FAIL', 120)], opts);
  assert.equal(r.tripped, true);
  assert.equal(r.fails, 3);
  assert.ok(r.retryAt instanceof Date);
  // 放行时间 = 最后一次失败 + 冷却时长
  assert.equal(r.retryAt.getTime(), NOW + 12 * 3600_000);
});

test('中间成功过：计数从成功处断开，不累计', () => {
  const rows = [
    row('UNKNOWN', 0), row('UNKNOWN', 60),
    row('SUCCESS', 120),               // ← 链子在这里接上了
    row('UNKNOWN', 180), row('UNKNOWN', 240),
  ];
  const r = breakerState(rows, opts);
  assert.equal(r.tripped, false);
  assert.equal(r.fails, 2);
});

test('ALREADY 和 SUCCESS 一样能清零', () => {
  const rows = [row('UNKNOWN', 0), row('UNKNOWN', 60), row('ALREADY', 120)];
  assert.equal(breakerState(rows, opts).fails, 2);
});

test('BUSY / SKIPPED 不算失败，也不打断连续性', () => {
  // 遇忙让路和"今天已签"都是设计内的行为，把它们算成失败会让熔断莫名其妙地触发
  const rows = [
    row('BUSY', 0), row('UNKNOWN', 60),
    row('SKIPPED', 120), row('UNKNOWN', 180), row('UNKNOWN', 240),
  ];
  const r = breakerState(rows, opts);
  assert.equal(r.fails, 3);
  assert.equal(r.tripped, true);
});

test('CIRCUIT 记录不会把自己越数越多', () => {
  // 熔断期间每次运行都会写一条 CIRCUIT。若把它算进 fails，
  // 计数会永久膨胀，冷却结束后也永远回不到阈值以下
  const rows = [
    row('CIRCUIT', 0), row('CIRCUIT', 30), row('CIRCUIT', 60),
    row('UNKNOWN', 120), row('UNKNOWN', 180), row('UNKNOWN', 240),
  ];
  const r = breakerState(rows, opts);
  assert.equal(r.fails, 3);
  assert.equal(r.tripped, true);
});

test('冷却结束：放行一次试探（半开）', () => {
  // 三条都发生在 13 小时前 → 超过 12 小时冷却
  const rows = [row('UNKNOWN', 780), row('UNKNOWN', 840), row('UNKNOWN', 900)];
  const r = breakerState(rows, opts);
  assert.equal(r.tripped, false);
  assert.equal(r.probe, true);
  assert.equal(r.retryAt, null);
});

test('冷却没结束：继续拦住', () => {
  const rows = [row('UNKNOWN', 60), row('UNKNOWN', 120), row('UNKNOWN', 180)];
  const r = breakerState(rows, opts);
  assert.equal(r.tripped, true);
  assert.equal(r.probe, false);
});

test('threshold=0 表示关闭熔断', () => {
  const rows = [row('UNKNOWN', 0), row('UNKNOWN', 60), row('UNKNOWN', 120), row('UNKNOWN', 180)];
  const r = breakerState(rows, { ...opts, threshold: 0 });
  assert.equal(r.tripped, false);
  assert.equal(r.fails, 0);
});

test('没有任何历史：不熔断', () => {
  const r = breakerState([], opts);
  assert.equal(r.tripped, false);
  assert.equal(r.fails, 0);
});

test('dry-run 的失败不参与熔断计数', () => {
  // 2026-10-31 踩过：`--dry-run` 在沙箱里开不了调试端口 → FAIL 写进 history，
  // 差一点把第二天的自动运行算成"连续失败"。诊断失败不该停掉真实任务。
  const rows = [
    row('FAIL', 0), row('FAIL', 60), row('FAIL', 120),
  ].map((r) => ({ ...r, dry_run: true }));
  const r = breakerState(rows, opts);
  assert.equal(r.fails, 0);
  assert.equal(r.tripped, false);
});

test('dry-run 记录夹在中间：只数真实的失败', () => {
  const rows = [
    row('UNKNOWN', 0),
    { ...row('FAIL', 30), dry_run: true },   // 诊断失败，跳过
    row('UNKNOWN', 60),
  ];
  const r = breakerState(rows, opts);
  assert.equal(r.fails, 2);
  assert.equal(r.tripped, false);
});

test('at 字段损坏：按"没冷却过"放行，不能因为一条脏记录永久卡住', () => {
  const rows = [
    { result: 'UNKNOWN', at: 'not-a-date' },
    { result: 'UNKNOWN', at: 'not-a-date' },
    { result: 'UNKNOWN', at: 'not-a-date' },
  ];
  const r = breakerState(rows, opts);
  assert.equal(r.tripped, false);
  assert.equal(r.probe, true);
});
