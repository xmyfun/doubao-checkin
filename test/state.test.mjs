/**
 * 页面状态判定。
 *
 * 输入是**采集层从页面读出来的字段**（found / loginPrompt / hasRewarded / buttonText…），
 * 不是 DOM 本身 —— DOM 怎么变成这些字段在 bin/checkin.mjs 里，那部分只能真机验证。
 * 这里钉住的是「拿这些字段怎么下判断」：判错方向的代价不对称，
 * 把"不该点"判成"该点"会在异常状态下反复调写接口。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, shouldClaim, VERDICT } from '../src/state.mjs';
import { APP } from '../src/app-profile.mjs';

/** 各状态下的页面快照（字段含义见 checkin.mjs 的采集函数） */
const snap = {
  pending: {
    found: true,
    loginPrompt: false,
    hasRewarded: false,
    buttonText: '立即签到',
    buttonDisabled: false,
    cardText: '每日签到 +200 额度 立即签到',
  },
  done: {
    found: true,
    loginPrompt: false,
    hasRewarded: true,
    buttonText: null,
    buttonDisabled: null,
    cardText: '每日签到 +200 额度 已签到',
  },
  notLoggedIn: {
    found: false,
    loginPrompt: true,
    bodyLen: 120,
    rewardCodes: [],
  },
  cardGone: {
    found: false,
    loginPrompt: false,
    bodyLen: 800,
    rewardCodes: ['other_task'],
  },
  disabled: {
    found: true,
    loginPrompt: false,
    hasRewarded: false,
    buttonText: '立即签到',
    buttonDisabled: true,
  },
  /** 卡片在，但按钮文案不认识（活动改版 / 换成了别的活动） */
  unknownButton: {
    found: true,
    loginPrompt: false,
    hasRewarded: false,
    buttonText: '去看看',
    buttonDisabled: false,
  },
  /** 登录提示和卡片同时在：页面上有登录入口，但卡片也能读 —— 不能判成未登录 */
  loginBanner: {
    found: true,
    loginPrompt: true,
    hasRewarded: false,
    buttonText: '立即签到',
    buttonDisabled: false,
  },
  weird: {
    found: true,
    loginPrompt: false,
    hasRewarded: false,
    buttonText: null,
    buttonDisabled: null,
    cardText: '每日签到',
  },
};

test('未签到 → PENDING，且应该发起写请求', () => {
  assert.equal(judge(snap.pending, APP), VERDICT.PENDING);
  assert.equal(shouldClaim(VERDICT.PENDING), true);
});

test('已签到 → DONE，不该再点', () => {
  assert.equal(judge(snap.done, APP), VERDICT.DONE);
  assert.equal(shouldClaim(VERDICT.DONE), false);
});

test('未登录 → AUTH_FAIL，不该点', () => {
  assert.equal(judge(snap.notLoggedIn, APP), VERDICT.AUTH_FAIL);
  assert.equal(shouldClaim(VERDICT.AUTH_FAIL), false);
});

test('找不到卡片 → UNKNOWN，绝不猜着点', () => {
  assert.equal(judge(snap.cardGone, APP), VERDICT.UNKNOWN);
  assert.equal(shouldClaim(VERDICT.UNKNOWN), false);
});

test('按钮 disabled → UNKNOWN（活动未开始/已领完都不该点）', () => {
  assert.equal(judge(snap.disabled, APP), VERDICT.UNKNOWN);
});

test('按钮文案不认识 → UNKNOWN（不能因为"有按钮"就当签到按钮）', () => {
  assert.equal(judge(snap.unknownButton, APP), VERDICT.UNKNOWN);
});

test('登录提示和卡片同时在 → 按卡片判，不误判成未登录', () => {
  assert.equal(judge(snap.loginBanner, APP), VERDICT.PENDING);
});

test('结构不认识 → UNKNOWN', () => {
  assert.equal(judge(snap.weird, APP), VERDICT.UNKNOWN);
});

test('空快照不崩 → UNKNOWN', () => {
  assert.equal(judge(null, APP), VERDICT.UNKNOWN);
});

test('按钮文案匹配用传入的配置（自定义 pattern 的 flags 不能被丢掉）', () => {
  // 判定里如果写成 new RegExp(source) 而不是连 flags 一起重建，i 标志会静默失效
  const custom = { ...APP, pendingTextPattern: /sign/i };
  assert.equal(judge({ ...snap.pending, buttonText: 'SIGN NOW' }, custom), VERDICT.PENDING);
});

test('除 PENDING 外，任何判定都不触发写请求', () => {
  for (const v of Object.values(VERDICT)) {
    if (v === VERDICT.PENDING) continue;
    assert.equal(shouldClaim(v), false, `${v} 不应触发写请求`);
  }
});

test('判定依赖的 profile 字段齐备（漏一个会让 judge 悄悄判错）', () => {
  // 这些字段是 app-profile.mjs 里跟豆包版本耦合的部分，官方改版时最容易被误删
  assert.equal(typeof APP.app, 'string');
  assert.ok(APP.cardSelector.length > 0, '卡片锚点不能为空');
  for (const k of ['pendingTextPattern', 'rewardedPattern', 'loginPattern']) {
    assert.ok(APP[k] instanceof RegExp, `APP.${k} 必须是正则`);
  }
  assert.ok(Number.isInteger(APP.port) && APP.port > 1024 && APP.port < 65536,
    `APP.port 应该是可用的端口号，实际 ${APP.port}`);
});
