/**
 * 客户端健康快照。
 *
 * 这些是 `--doctor` 和 `--repair` 的判断依据，而它们全都**读用户机器上的真实文件**，
 * 所以必须能指向临时目录 —— 否则测试会读开发者本机的豆包数据，
 * 在别人机器上跑出来的结果完全不同（测试时红时绿，最消耗信任）。
 *
 * 钉住的重点是**容错**：文件缺失、JSON 损坏、字段不存在，都要返回 null/空而不是抛。
 * doctor 是用来排查问题的，它自己崩掉比什么都糟。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExitType, cacheStatus, formatAge, humanBytes, GPU_CACHE_DIRS } from '../src/health.mjs';

/** 建一个临时 user-data 目录，返回路径；测试结束自动删 */
function tmpUserData(t) {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePrefs(dir, obj) {
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify(obj));
}

test('exit_type：正常读到 Crashed', (t) => {
  const dir = tmpUserData(t);
  writePrefs(dir, { profile: { exit_type: 'Crashed' } });
  assert.equal(readExitType(dir), 'Crashed');
});

test('exit_type：Preferences 不存在时返回 null，不抛', (t) => {
  const dir = tmpUserData(t);
  assert.equal(readExitType(dir), null);
});

test('exit_type：JSON 损坏时返回 null，不抛', (t) => {
  const dir = tmpUserData(t);
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Default', 'Preferences'), '{ 这不是 JSON');
  assert.equal(readExitType(dir), null);
});

test('exit_type：profile 里没有这个键时返回 null', (t) => {
  const dir = tmpUserData(t);
  writePrefs(dir, { profile: { other: 1 } });
  assert.equal(readExitType(dir), null);
});

test('exit_type：值是数字之类的非字符串时返回 null', (t) => {
  const dir = tmpUserData(t);
  writePrefs(dir, { profile: { exit_type: 42 } });
  assert.equal(readExitType(dir), null);
});

test('cacheStatus：目录不存在时标 exists=false，不抛', (t) => {
  const dir = tmpUserData(t);
  const list = cacheStatus(dir);
  assert.equal(list.length, GPU_CACHE_DIRS.length);
  assert.ok(list.every((c) => c.exists === false && c.mtimeMs === null));
});

test('cacheStatus：统计文件数、字节数与 ageHours', (t) => {
  const dir = tmpUserData(t);
  const cacheDir = join(dir, 'Default', 'GPUCache');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'a.bin'), Buffer.alloc(100));
  writeFileSync(join(cacheDir, 'b.bin'), Buffer.alloc(50));
  // 钉一个确定的时间：10 小时前
  const tenHoursAgo = new Date(Date.now() - 10 * 3600_000);
  utimesSync(cacheDir, tenHoursAgo, tenHoursAgo);

  const hit = cacheStatus(dir).find((c) => c.rel === 'Default/GPUCache');
  assert.equal(hit.exists, true);
  assert.equal(hit.files, 2);
  assert.equal(hit.bytes, 150);
  assert.ok(hit.ageHours >= 9.5 && hit.ageHours <= 10.5, `ageHours 应约为 10，实际 ${hit.ageHours}`);
});

test('cacheStatus：三个目录的顺序固定（doctor 的输出顺序不能漂）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-health-'));
  try {
    assert.deepEqual(cacheStatus(dir).map((c) => c.rel), GPU_CACHE_DIRS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatAge：分钟级 / 小时级 / 天数级', () => {
  assert.equal(formatAge(0.5), '1 小时内');
  assert.equal(formatAge(5), '5 小时前');
  assert.equal(formatAge(24), '1 天前');
  assert.equal(formatAge(432), '18 天前');
  assert.equal(formatAge(null), '未知');
});

test('humanBytes：B / K / M', () => {
  assert.equal(humanBytes(0), '0B');
  assert.equal(humanBytes(512), '512B');
  assert.equal(humanBytes(2048), '2K');
  assert.equal(humanBytes(7 * 1024 * 1024), '7.0M');
});
