/**
 * 日志模块。
 *
 * 每个用例都在**自己的空目录**里跑：日志目录是模块级全局状态（setLogDir），
 * 共用一个目录会让测试之间靠"前面写过什么"传递状态 —— 那样单跑任意一条就红
 * （用 `--test-name-pattern` 单跑一条就会红）。测试必须能单独跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  appendHistory, readHistory, summarize, writeRun, logPath, historyPath, logDir, setLogDir,
  displayWidth, wrapDisplay, expandPath,
} from '../src/log.mjs';

/** 给当前用例开一个独立目录，并让 log.mjs 指向它 */
function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-log-test-'));
  setLogDir(dir);
  t.after(() => {
    setLogDir('');
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('日志目录受 config 的 logDir 控制', (t) => {
  const dir = freshDir(t);
  assert.equal(logDir(), dir);
  assert.equal(logPath(), join(dir, 'checkin.log'));
  assert.equal(historyPath(), join(dir, 'history.jsonl'));
});

test('appendHistory 后 readHistory 能读回', (t) => {
  freshDir(t);
  appendHistory({ at: 1000, date: '2026-01-01', result: 'SUCCESS', report: '签到成功' });
  const rows = readHistory(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, 'SUCCESS');
  assert.equal(rows[0].date, '2026-01-01');
});

test('readHistory 最新的在前（按写入顺序倒序）', (t) => {
  freshDir(t);
  appendHistory({ at: 1000, result: 'SUCCESS' });
  appendHistory({ at: 2000, result: 'ALREADY' });
  appendHistory({ at: 3000, result: 'SKIPPED' });
  assert.deepEqual(readHistory(10).map((r) => r.result), ['SKIPPED', 'ALREADY', 'SUCCESS']);
});

test('readHistory 的 n 参数只取最近 n 条', (t) => {
  freshDir(t);
  for (const [i, result] of ['SUCCESS', 'ALREADY', 'BUSY'].entries()) {
    appendHistory({ at: (i + 1) * 1000, result });
  }
  assert.deepEqual(readHistory(2).map((r) => r.result), ['BUSY', 'ALREADY']);
  assert.equal(readHistory(1).length, 1);
});

test('readHistory 跳过坏行，不让一行 JSON 出错就整份读不出来', (t) => {
  freshDir(t);
  appendHistory({ at: 1000, result: 'SUCCESS' });
  // 模拟上次写到一半被 kill：末尾留下半行
  writeFileSync(historyPath(), `${readFileSync(historyPath(), 'utf8')}{"at":2000,"resu`, 'utf8');
  const rows = readHistory(10);
  assert.equal(rows.length, 1, '坏行应被丢弃，好行仍然读得到');
  assert.equal(rows[0].result, 'SUCCESS');
});

test('summarize 统计各结果数量（BUSY 不能算进 SKIPPED）', (t) => {
  // 遇忙跳过的后果和"今天已签所以跳过"完全相反：前者可能漏签，后者任务已完成。
  // 混成一个数字，等于把"今天白跑了"藏进"正常"里 —— 这就是加 BUSY 的原因。
  freshDir(t);
  appendHistory({ at: 1000, result: 'SUCCESS' });
  appendHistory({ at: 2000, result: 'ALREADY' });
  appendHistory({ at: 3000, result: 'SKIPPED' });
  appendHistory({ at: 4000, result: 'BUSY' });
  appendHistory({ at: 5000, result: 'FAIL', needs_attention: true });

  const s = summarize(readHistory(100));
  assert.equal(s.total, 5);
  assert.equal(s.claimed, 1);
  assert.equal(s.already, 1);
  assert.equal(s.skipped, 1, 'SKIPPED 只算「已签 / 拿不到锁」，不能把遇忙算进来');
  assert.equal(s.busy, 1, '遇忙必须单独计数');
  assert.equal(s.failed, 1, '失败按 needs_attention 算，不是按 result 名');
});

test('summarize 的分类加起来等于总次数（不留"其他"黑洞）', (t) => {
  // 每种结果都必须落进某个桶里。少一个桶，--log 底部那几个数字加起来就会
  // 小于总次数 —— 用户会以为记录丢了，其实是被统计漏掉了。
  freshDir(t);
  const results = ['SUCCESS', 'ALREADY', 'SKIPPED', 'BUSY', 'CIRCUIT', 'REPAIR', 'PENDING', 'UNKNOWN'];
  results.forEach((r, i) => appendHistory({
    at: 1000 * (i + 1), result: r, needs_attention: r === 'UNKNOWN',
  }));

  const s = summarize(readHistory(100));
  const sum = s.claimed + s.already + s.skipped + s.busy + s.circuit + s.repair + s.pending + s.failed;
  assert.equal(sum, s.total, `分类加起来 ${sum}，总次数 ${s.total}`);
  assert.equal(s.repair, 1, 'REPAIR 要单独计数');
  assert.equal(s.pending, 1, 'PENDING（dry-run）要单独计数');
});

test('summarize 的 lastOk / lastFail 取最近一次（最新在前）', (t) => {
  freshDir(t);
  appendHistory({ at: 1000, result: 'SUCCESS' });
  appendHistory({ at: 2000, result: 'ALREADY' });
  appendHistory({ at: 3000, result: 'FAIL', needs_attention: true });
  const s = summarize(readHistory(100));
  assert.equal(s.lastOk, 2000, 'SUCCESS 和 ALREADY 都算"签到成功过"');
  assert.equal(s.lastFail, 3000);
});

test('summarize 空历史不会崩，也不会报出"成功过"', (t) => {
  freshDir(t);
  const s = summarize(readHistory(10));
  assert.equal(s.total, 0);
  assert.equal(s.lastOk, null);
  assert.equal(s.lastFail, null);
});

test('writeRun 写入可读流水，并跳过纯分隔线', (t) => {
  freshDir(t);
  const t0 = Date.now();
  writeRun([
    { at: t0, msg: '豆包签到' },
    { at: t0, msg: '──────────────────' },   // 纯分隔线应被跳过
    { at: t0 + 500, msg: '结论      [SUCCESS] 签到成功' },
  ], { duration_ms: 500 });

  assert.ok(existsSync(logPath()));
  const text = readFileSync(logPath(), 'utf8');
  assert.match(text, /^===== /);
  assert.match(text, /豆包签到/);
  assert.match(text, /\[SUCCESS\]/);
  assert.match(text, /耗时\s+0\.5s/);
  assert.doesNotMatch(text, /──────/);
});

// ── logDir 的路径展开（config.conf 里可能写 ~ 或相对路径） ──

test('expandPath：~/ 展开成家目录，相对路径按项目根解析', () => {
  assert.equal(expandPath('~/logs'), join(homedir(), 'logs'));
  assert.equal(expandPath('~'), homedir());
  assert.equal(expandPath('/tmp/abs'), '/tmp/abs');

  const rel = expandPath('logs');
  assert.ok(isAbsolute(rel), `相对路径必须变成绝对路径（launchd 不认相对路径），实际：${rel}`);
  assert.ok(rel.endsWith('/logs'));
});

test('expandPath：空值原样返回，不把空串变成项目根', () => {
  assert.equal(expandPath(''), '');
  assert.equal(expandPath(null), null);
  assert.equal(expandPath(undefined), undefined);
});

// ── --log 说明列的折行（按字符数硬截会把中文从句子中间断开） ──

test('displayWidth：中文算 2 列，ASCII 算 1 列', () => {
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文abc'), 7);
  assert.equal(displayWidth(''), 0);
});

test('wrapDisplay：短文本不折行，原样返回一行', () => {
  assert.deepEqual(wrapDisplay('签到成功：每日签到 +200 额度', 46), ['签到成功：每日签到 +200 额度']);
  assert.deepEqual(wrapDisplay('', 46), ['']);
});

test('wrapDisplay：长说明折行后一个字都不丢（不能再从句子中间截断）', () => {
  const note = '客户端正在执行任务（网入中位 1.2KB/s > 1KB/s），本次跳过。';
  const lines = wrapDisplay(note, 46);
  assert.ok(lines.length > 1, '这条本来就超过 46 列，应该折成多行');
  const strip = (s) => s.replace(/\s+/g, '');
  assert.equal(lines.map(strip).join(''), strip(note), '折行不能丢字符');
  assert.ok(lines.at(-1).endsWith('跳过。'), '结尾的「跳过。」必须还在（按字符硬截时，就是它被切掉的）');
});

test('wrapDisplay：每行不超过给定列宽', () => {
  const note = '客户端正在执行任务（网入中位 2.7KB/s > 1KB/s），本次跳过。';
  for (const w of [20, 30, 46, 60]) {
    for (const l of wrapDisplay(note, w)) {
      assert.ok(displayWidth(l) <= w, `宽度 ${w} 时这一行超了：${l}（${displayWidth(l)} 列）`);
    }
  }
});

test('wrapDisplay：数字和单位不被切开（1.2KB/s 必须完整出现在某一行）', () => {
  const lines = wrapDisplay('客户端正在执行任务（网入中位 1.2KB/s > 1KB/s），本次跳过。', 46);
  assert.ok(lines.some((l) => l.includes('1.2KB/s')), `1.2KB/s 被切开了：${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.includes('1KB/s')));
});

test('wrapDisplay：逗号、右括号不落在行首（避头尾）', () => {
  const lines = wrapDisplay('客户端正在执行任务（网入中位 2.7KB/s > 1KB/s），本次跳过。', 46);
  for (const l of lines.slice(1)) {
    assert.doesNotMatch(l, /^[，。、；：？！）】》」』]/, `标点顶到行首了：${l}`);
  }
});

test('wrapDisplay：超长英文串按列宽硬拆，但字符不丢', () => {
  const long = 'a'.repeat(120);
  const lines = wrapDisplay(long, 30);
  assert.equal(lines.join(''), long);
  assert.ok(lines.every((l) => displayWidth(l) <= 30));
});

test('wrapDisplay：列宽非法时也不死循环（最小按 4 列走）', () => {
  const lines = wrapDisplay('中文测试abcd', 0);
  assert.ok(lines.length >= 1);
  assert.equal(lines.join(''), '中文测试abcd');
});
