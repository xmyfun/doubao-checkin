/**
 * 弹窗去抖判定。
 *
 * 只测 shouldFire 这个纯函数 —— **绝不能测 notify() 本身**：它真的会调 osascript
 * 弹到屏幕上。2026-10-31 的集成测试就踩过：弹窗出现在用户桌面，还把
 * .notify-state.json 里的 CIRCUIT 名额占掉 6 小时，真实熔断反而不会提醒。
 *
 * 钉住的核心行为是「**按 key 独立**」而不是全局：一个失败类别弹过之后，
 * 不能把另一个类别的提醒也一起吞掉 —— 用户最需要知道的是"出了哪种问题"，
 * 只报第一种、后几种永远静音，是最坑的失败方式。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFire } from '../src/notify.mjs';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

const at = (hoursAgo) => NOW - hoursAgo * HOUR;

test('从未弹过：弹', () => {
  assert.equal(shouldFire({}, 'UNKNOWN', { now: NOW }), true);
});

test('6 小时内同类：不弹', () => {
  const state = { UNKNOWN: at(2) };
  assert.equal(shouldFire(state, 'UNKNOWN', { now: NOW }), false);
});

test('超过 6 小时：重新弹', () => {
  const state = { UNKNOWN: at(7) };
  assert.equal(shouldFire(state, 'UNKNOWN', { now: NOW }), true);
});

test('刚好到 6 小时：弹（边界取 >=，不是 >）', () => {
  const state = { UNKNOWN: at(6) };
  assert.equal(shouldFire(state, 'UNKNOWN', { now: NOW }), true);
});

test('按 key 独立：UNKNOWN 弹过不影响 AUTH_FAIL', () => {
  // 这是最关键的一条 —— 全局去抖会让"登录失效"被"找不到卡片"静音 6 小时
  const state = { UNKNOWN: at(1) };
  assert.equal(shouldFire(state, 'UNKNOWN', { now: NOW }), false);
  assert.equal(shouldFire(state, 'AUTH_FAIL', { now: NOW }), true);
  assert.equal(shouldFire(state, 'CIRCUIT', { now: NOW }), true);
  assert.equal(shouldFire(state, 'ERR:1', { now: NOW }), true);
});

test('不同错误码也算不同类别', () => {
  const state = { 'ERR:1': at(1) };
  assert.equal(shouldFire(state, 'ERR:2', { now: NOW }), true);
});

test('debounceMs = 0：不去抖，每次都弹', () => {
  const state = { UNKNOWN: at(0) };
  assert.equal(shouldFire(state, 'UNKNOWN', { now: NOW, debounceMs: 0 }), true);
});

test('自定义时长生效', () => {
  const state = { UNKNOWN: at(2) };
  assert.equal(shouldFire(state, 'UNKNOWN', { now: NOW, debounceMs: 1 * HOUR }), true);
  assert.equal(shouldFire(state, 'UNKNOWN', { now: NOW, debounceMs: 12 * HOUR }), false);
});

test('状态里是脏值（0 / null）时按"没弹过"处理', () => {
  assert.equal(shouldFire({ UNKNOWN: 0 }, 'UNKNOWN', { now: NOW }), true);
  assert.equal(shouldFire({ UNKNOWN: null }, 'UNKNOWN', { now: NOW }), true);
});
