/**
 * 校准的纯统计函数。
 *
 * 这些公式决定了"什么算忙"，而判错的方向是不对称的：
 * 门槛偏低 → 用户正在干活时被重启（很烦）；门槛偏高 → 当天漏签（靠兜底补）。
 * 所以它们的边界值得逐条钉死，而不是靠跑一次真机看看差不多。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  delta, cpuRates, windowsOf, deriveThresholds, tailThreshold, autoTailCount, phaseStats,
} from '../src/calibrate.mjs';

/** 造一个样本点：t 是相对秒数（字符串，和真实采样一致） */
const S = (t, cpu, phase, extra = {}) => ({
  t: String(t), cpu_s: cpu, phase, edge: 0,
  net_in: 0, net_out: 0, disk_bps: null, input_idle_s: null, procs: 20, rss_kb: 0,
  ...extra,
});

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} 应约等于 ${b}`);

/** 空闲 4 点（斜率 0.1/秒）+ 任务 6 点（前 4 点 0.3/秒，后 2 点几乎不动） */
const idle = [0, 3, 6, 9].map((t, i) => S(t, 0.3 * i, 'idle'));
const taskRamp = [12, 15, 18, 21].map((t, i) => S(t, 1.8 + 0.9 * i, 'task'));
const taskFlat = [24, 27].map((t) => S(t, 4.6, 'task'));
const withTail = [...idle, ...taskRamp, ...taskFlat];
const TASK_IDX = [4, 5, 6, 7, 8, 9];

test('cpuRates：用相邻样本的差值算速率，首点为 null', () => {
  const r = cpuRates(idle, [0, 1, 2, 3]);
  assert.equal(r[0], null, '第一个点没有前一个样本，必须是 null 而不是 0');
  near(r[1], 0.1); near(r[2], 0.1); near(r[3], 0.1);
});

test('cpuRates：cpu_s 缺失时给 null，不参与统计', () => {
  const s = [S(0, null, 'idle'), S(3, 0.3, 'idle')];
  assert.deepEqual(cpuRates(s, [0, 1]), [null, null]);
});

/**
 * 按阶段拼一段样本：每 3 秒一个点，cpu_s 是累计值，所以斜率就是"占几个核"。
 * 15 个点 → 14 个速率 → 5 个 10 速率窗口，够算分布。
 */
function build(phases) {
  const out = [];
  let t = 0; let cpu = 0;
  for (const p of phases) {
    for (let i = 0; i < p.n; i++) {
      out.push({ ...S(t, cpu, p.key), net_in: 0, procs: 20 });
      t += 3; cpu += p.rate * 3;
    }
  }
  return out;
}
const PHASES = [
  { key: 'idle', n: 15, rate: 0.05 },
  { key: 'chat', n: 15, rate: 0.5 },
  { key: 'task', n: 15, rate: 0.7 },
  { key: 'task_fallback', n: 15, rate: 0.2 },
];
const run1 = build(PHASES);

test('windowsOf：按运行时的口径切成 10 个速率一个窗口，取窗口中位', () => {
  const w = windowsOf(run1, 'idle');
  assert.equal(w.rates, 14, '15 个点只能出 14 个速率');
  assert.equal(w.windows.length, 5, '14 个速率刚好 5 个窗口');
  assert.equal(w.short, false);
  near(w.windows[0].cpu, 0.05);
});

test('windowsOf：速率不足 10 个时退化为整段一个窗口，并标记 short', () => {
  const w = windowsOf(build([{ key: 'idle', n: 6, rate: 0.05 }]), 'idle');
  assert.equal(w.rates, 5);
  assert.equal(w.windows.length, 1);
  assert.equal(w.short, true, '这种窗口没有分布，p90 就等于最大值，调用方必须知道');
  near(w.windows[0].cpu, 0.05);
});

test('windowsOf：没样本的阶段给空窗口，不抛异常', () => {
  assert.deepEqual(windowsOf(run1, 'task_fallback_x').windows, []);
  assert.equal(windowsOf([], 'idle').rates, 0);
});

test('deriveThresholds：门槛取空闲与忙碌的几何中点，不贴着空闲走', () => {
  const d = deriveThresholds(run1);
  assert.equal(d.ok, true);
  near(d.idleP90, 0.05, 1e-9);
  near(d.busyP05, 0.5, 1e-9);
  // √(0.05×0.5)=0.158 → 保留两位 0.16
  assert.equal(d.cpu, 0.16);
  assert.ok(d.cpu > d.idleP90 * 2.5, '必须离空闲足够远，否则空闲毛刺会被判忙');
  assert.ok(d.cpu < d.busyP05 * 0.5, '必须离忙碌足够远，否则刚聊起来会被判闲');
});

test('deriveThresholds：历史空闲更高时门槛被抬高（防止换个时段天天判忙）', () => {
  const d = deriveThresholds(run1, { historyIdle: [0.29] });
  assert.equal(d.ok, true);
  assert.equal(d.historicalIdle, 0.29);
  near(d.idleRef, 0.29, 1e-9);
  assert.ok(d.cpu > 0.29, `门槛 ${d.cpu} 必须高于历史空闲，否则那天全被判忙`);
  near(d.lo, 0.29 * 1.1);
});

test('deriveThresholds：门槛不能高过忙碌下沿的 0.9（否则真忙时判闲）', () => {
  // 空闲 0.3、忙碌 0.5：√(0.3×0.5)=0.387，比 0.5×0.9=0.45 低，不受夹逼
  const d = deriveThresholds(build([
    { key: 'idle', n: 15, rate: 0.3 },
    { key: 'chat', n: 15, rate: 0.5 },
  ]));
  assert.equal(d.ok, true);
  assert.ok(d.cpu <= 0.5 * 0.9 + 1e-9);
});

test('deriveThresholds：空闲和忙碌分不开时拒绝给建议值', () => {
  const d = deriveThresholds(build([
    { key: 'idle', n: 15, rate: 0.3 },
    { key: 'chat', n: 15, rate: 0.32 },
  ]));
  assert.equal(d.ok, false);
  assert.match(d.reason, /分不开/);
  assert.equal(d.cpu, undefined, '分不开就不该给出一个"看着能用"的数字');
});

test('deriveThresholds：没有空闲样本 / 没有忙碌样本时都拒绝', () => {
  assert.equal(deriveThresholds([]).ok, false);
  assert.equal(deriveThresholds(build([{ key: 'idle', n: 15, rate: 0.05 }])).ok, false);
  assert.match(deriveThresholds(build([{ key: 'idle', n: 15, rate: 0.05 }])).reason, /对话|任务/);
});

test('deriveThresholds：edge=1 的空闲样本不进基线', () => {
  const dirty = run1.map((x) => (x.phase === 'idle' ? { ...x, edge: 1 } : x));
  assert.equal(deriveThresholds(dirty).ok, false, '空闲样本被标 edge 后等于没采到');
});

test('deriveThresholds：网入门槛有 1 KB/s 下限（空闲几乎无流量时不至于见流量就判忙）', () => {
  assert.equal(deriveThresholds(run1).netKB, 1);
});

test('deriveThresholds：回落值只作参考，不参与门槛计算', () => {
  const base = deriveThresholds(run1);
  const highFb = deriveThresholds(build(PHASES.map((p) => (
    p.key === 'task_fallback' ? { ...p, rate: 5 } : p))));
  assert.equal(highFb.cpu, base.cpu, '回落再高也不能改变 CPU 门槛');
  near(base.fallbackCpu, 0.2, 1e-9);
});

test('tailThreshold：门槛落在"任务峰值"和"回落"之间', () => {
  const t = tailThreshold(withTail, TASK_IDX);
  near(t, 0.18);                          // max(0.1×2, 0.3×0.4)=0.2 与 0.3×0.6=0.18 取小
  assert.ok(t < 0.3, '必须低于任务峰值，否则任务本身会被当成回落');
  assert.ok(t > 0.1, '必须高于空闲，否则回落区间的噪声也会被当成忙');
});

test('autoTailCount：尾部连续 2 个不忙 → 判为任务结束后的回落，全部剔掉', () => {
  assert.equal(autoTailCount(withTail, TASK_IDX), 2);
});

test('autoTailCount：只有 1 个不忙 → 可能是任务内部静默间隙，保留', () => {
  const once = [...idle, ...taskRamp, S(24, 4.53, 'task')];
  assert.equal(autoTailCount(once, [4, 5, 6, 7, 8]), 0);
});

test('autoTailCount：全忙或全闲时都不剔', () => {
  assert.equal(autoTailCount(idle, [0, 1, 2, 3]), 0, '全闲：没有"最后一个忙样本"，不该剔');

  // 全忙：任务一直跑，尾部没有回落，也不该剔（否则会把有效数据丢掉）
  const allBusy = build([
    { key: 'idle', n: 6, rate: 0.05 },
    { key: 'task', n: 10, rate: 2 },
  ]);
  const taskIdx = Array.from({ length: 10 }, (_, i) => i + 6);
  assert.equal(autoTailCount(allBusy, taskIdx), 0, '全忙：尾部没有回落，不该剔');
});

test('phaseStats：剔除 edge 样本后再统计', () => {
  const s = [...idle.map((x, i) => (i === 3 ? { ...x, edge: 1 } : x))];
  const st = phaseStats(s, 'idle');
  assert.equal(st.n, 3, '4 个样本里有 1 个 edge，应只剩 3 个');
  assert.equal(st.span, 6);              // t=0 → t=6
  assert.equal(st.procsMax, 20);
});

test('phaseStats：样本不足 2 个时返回 null', () => {
  assert.equal(phaseStats([S(0, 0, 'idle')], 'idle'), null);
  assert.equal(phaseStats(idle, 'task'), null, '该阶段没样本');
});

test('delta：任一为 null 就给 null，不做"当 0 处理"', () => {
  assert.equal(delta({ x: null }, { x: 5 }, 'x'), null);
  assert.equal(delta({ x: 5 }, { x: 2 }, 'x'), 0, '计数器回退（重启）时钳到 0，不能出负速率');
  assert.equal(delta({ x: 1 }, { x: 4 }, 'x'), 3);
});
