/**
 * 忙闲判定的纯函数部分（judgeWindow / parseCpuTime）。
 *
 * 采样（processTree / netBytes / collectOnce）必须跑真实进程，只能真机验证；
 * 这里钉住的是「给一串样本，怎么下判断」—— 判错的方向不对称：
 * 判成"闲"会把用户正在跑的任务重启掉，所以判定宁可保守。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeWindow, parseCpuTime } from '../src/busy.mjs';

/** 造一串样本：CPU 每秒涨 rateCPU，网入每秒涨 rateNet（单位都是字节 / 秒） */
function makeSamples({ n = 11, dt = 3, cpu = 0.3, net = 0, t0 = 0 }) {
  const out = [];
  let c = 100; let ni = 1000;
  out.push({ t: t0, cpu_s: c, net_in: ni });
  for (let i = 1; i < n; i++) {
    c += cpu * dt;
    ni += net * dt;
    out.push({ t: t0 + i * dt * 1000, cpu_s: c, net_in: ni });
  }
  return out;
}

const TH = { cpuThreshold: 0.35, netInKBps: 1 };

test('judgeWindow：空闲（CPU 0.3 / 网入 0）→ 不忙', () => {
  const v = judgeWindow(makeSamples({ cpu: 0.3, net: 0 }), TH);
  assert.equal(v.busy, false);
  assert.ok(Math.abs(v.cpuMedian - 0.3) < 0.01);
  assert.equal(v.evaluable, true);
  assert.equal(v.samples, 11);
});

test('judgeWindow：对话中（CPU 1.1）→ 忙，理由是 CPU', () => {
  const v = judgeWindow(makeSamples({ cpu: 1.1, net: 2200 }), TH);
  assert.equal(v.busy, true);
  assert.ok(v.reasons.some((r) => r.startsWith('CPU')));
});

test('judgeWindow：CPU 低谷但网入高（模型在思考）→ 忙，理由是网络', () => {
  // 这是实测里最容易误判的情况：CPU 0.31（和空闲一样），网入 10KB/s
  const v = judgeWindow(makeSamples({ cpu: 0.31, net: 10 * 1024 }), TH);
  assert.equal(v.busy, true);
  assert.ok(v.reasons.some((r) => r.startsWith('网入')));
});

test('judgeWindow：单个尖峰不影响结论（用中位数）', () => {
  // 11 个样本里只有一次采样突然涨了 263KB，其余平稳 → 不该判忙
  const s = makeSamples({ cpu: 0.25, net: 50 });
  s[5].net_in += 263 * 1024;
  const v = judgeWindow(s, TH);
  assert.equal(v.busy, false);
  assert.ok(Math.abs(v.netInMedian - 50) < 1, `中位数被尖峰带偏了：${v.netInMedian}`);
});

test('judgeWindow：速率个数为偶数时取上中位（保守：宁可判忙）', () => {
  // 4 个速率 [0.1, 0.1, 1.0, 1.0]：真中位是 0.55，这里取 1.0。
  // 这是有意的选择 —— 判忙的代价是"今天可能漏签"（有兜底），
  // 判闲的代价是把用户正在跑的任务重启掉，两者不对称。
  const s = [
    { t: 0, cpu_s: 0, net_in: 0 },
    { t: 3000, cpu_s: 0.3, net_in: 0 },
    { t: 6000, cpu_s: 0.6, net_in: 0 },
    { t: 9000, cpu_s: 3.6, net_in: 0 },
    { t: 12000, cpu_s: 6.6, net_in: 0 },
  ];
  const med = judgeWindow(s, TH).cpuMedian;
  assert.ok(Math.abs(med - 1) < 1e-9, `偶数个速率应取上中位 1.0，实际 ${med}`);
});

test('judgeWindow：CPU 计数器回落（进程重启）钳到 0，不判忙也不显示负值', () => {
  // 重启后 cputime 从 0 重新累计，差值会是负数。钳 0 比"负的 CPU 使用率"更合理，
  // 也让 `--log` 里不会出现「CPU 中位 -0.12 核」这种看不懂的数字。
  const s = makeSamples({ cpu: 0.3, net: 0 });
  for (let i = 4; i < s.length; i++) s[i].cpu_s -= 500;
  const v = judgeWindow(s, TH);
  assert.equal(v.busy, false);
  assert.deepEqual(v.reasons, []);
  assert.ok(v.cpuMedian >= 0, `CPU 中位不该为负：${v.cpuMedian}`);
});

test('judgeWindow：网入计数器回落被钳到 0，不会算出负速率', () => {
  const s = makeSamples({ cpu: 0.3, net: 0 });
  s[3].net_in = 0; // 计数器归零
  const v = judgeWindow(s, TH);
  assert.ok(v.netInMedian !== null);
  assert.ok(v.netInMedian >= 0, `网入速率不该为负：${v.netInMedian}`);
});

test('judgeWindow：两个样本时间戳相同 → 该窗口跳过，不产生 Infinity', () => {
  const s = [
    { t: 0, cpu_s: 0, net_in: 0 },
    { t: 0, cpu_s: 0.3, net_in: 0 },     // 与上一条同一毫秒，dt=0
    { t: 3000, cpu_s: 0.6, net_in: 0 },
  ];
  const v = judgeWindow(s, TH);
  assert.ok(Number.isFinite(v.cpuMedian), `dt=0 的窗口不该产生 Infinity：${v.cpuMedian}`);
  assert.ok(Math.abs(v.cpuMedian - 0.1) < 1e-9);
});

test('judgeWindow：CPU 采不到但网入有值 → 仍可评估（网入是兜底判据）', () => {
  const s = [
    { t: 0, cpu_s: null, net_in: 0 },
    { t: 3000, cpu_s: null, net_in: 30 * 1024 },
  ];
  const v = judgeWindow(s, TH);
  assert.equal(v.cpuMedian, null);
  assert.equal(v.evaluable, true);
  assert.equal(v.busy, true, 'CPU 缺失时不能把"没数据"当成"不忙"');
});

test('judgeWindow：样本不足 2 个 → 判不可评估', () => {
  const v = judgeWindow([{ t: 0, cpu_s: 1, net_in: 1 }], TH);
  assert.equal(v.evaluable, false);
  assert.equal(v.busy, false);
});

test('parseCpuTime：MM:SS.ff / HH:MM:SS / D-HH:MM:SS 三种格式都要对', () => {
  assert.ok(Math.abs(parseCpuTime('1:02.34') - 62.34) < 1e-6);
  assert.ok(Math.abs(parseCpuTime('0:00.01') - 0.01) < 1e-6);
  assert.ok(Math.abs(parseCpuTime('1:02:03') - 3723) < 1e-6);
  assert.ok(Math.abs(parseCpuTime('1:02:03.5') - 3723.5) < 1e-6, '带小数的 HH:MM:SS');
  assert.ok(Math.abs(parseCpuTime('1-02:03:04') - (86400 + 2 * 3600 + 3 * 60 + 4)) < 1e-6, '跨天格式');
});

test('parseCpuTime：空值与垃圾输入 → null（不抛异常）', () => {
  assert.equal(parseCpuTime(''), null);
  assert.equal(parseCpuTime(null), null);
  assert.equal(parseCpuTime('乱七八糟'), null);
});
