/**
 * 备份并清空 GPU 缓存。
 *
 * 这个模块会 `rmSync`，所以测试的重点不是"功能对不对"，而是**它绝不多删**：
 *   · 只动 GPU_CACHE_DIRS 里那三个目录
 *   · 会话数据（Cookies / IndexedDB / Local Storage）必须原样还在
 *   · 源目录被清空后仍然存在（客户端要往里写）
 *   · 备份里的文件数要和源目录一致
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupAndClearCaches, dirStats } from '../src/cache-clean.mjs';
import { GPU_CACHE_DIRS } from '../src/health.mjs';

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), 'doubao-clean-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('正常备份并清空：源目录还在、变空；备份里文件齐全', (t) => {
  const root = tmp(t);
  const userData = join(root, 'userdata');
  const backup = join(root, 'backup');

  const cacheDir = join(userData, 'Default', 'GPUCache');
  mkdirSync(join(cacheDir, 'nested'), { recursive: true });
  writeFileSync(join(cacheDir, 'data_0'), 'aaa');
  writeFileSync(join(cacheDir, 'nested', 'data_1'), 'bb');

  const result = backupAndClearCaches(backup, userData);
  const hit = result.find((r) => r.rel === 'Default/GPUCache');

  assert.equal(hit.files, 2);
  assert.ok(hit.bytes > 0, '字节数应当统计出来');
  assert.equal(hit.error, undefined);

  // 源目录必须仍然存在（客户端要往里写），且是空的
  assert.ok(existsSync(cacheDir), '源目录被整个删掉了 —— 客户端可能不认');
  assert.equal(readdirSync(cacheDir).length, 0);

  // 备份里两个文件都在
  assert.equal(dirStats(join(backup, 'Default_GPUCache')).files, 2);
});

test('根本不碰会话数据', (t) => {
  const root = tmp(t);
  const userData = join(root, 'userdata');
  const backup = join(root, 'backup');

  mkdirSync(join(userData, 'Default'), { recursive: true });
  writeFileSync(join(userData, 'Default', 'Cookies'), 'MY LOGIN');
  mkdirSync(join(userData, 'Default', 'Local Storage'), { recursive: true });
  writeFileSync(join(userData, 'Default', 'Local Storage', 'x.ldb'), 'CHAT');

  mkdirSync(join(userData, 'Default', 'GPUCache'), { recursive: true });
  writeFileSync(join(userData, 'Default', 'GPUCache', 'c'), 'cache');

  backupAndClearCaches(backup, userData);

  assert.ok(existsSync(join(userData, 'Default', 'Cookies')), 'Cookies 被删了！');
  assert.ok(existsSync(join(userData, 'Default', 'Local Storage', 'x.ldb')), '会话数据被删了！');
});

test('目录不存在：标记 skipped，不报错', (t) => {
  const root = tmp(t);
  const userData = join(root, 'userdata');
  mkdirSync(userData, { recursive: true });

  const result = backupAndClearCaches(join(root, 'backup'), userData);
  assert.equal(result.length, GPU_CACHE_DIRS.length);
  assert.ok(result.every((r) => r.skipped === true));
});

test('三个目录都被处理，顺序与 GPU_CACHE_DIRS 一致', (t) => {
  const root = tmp(t);
  const userData = join(root, 'userdata');
  for (const rel of GPU_CACHE_DIRS) {
    mkdirSync(join(userData, rel), { recursive: true });
    writeFileSync(join(userData, rel, 'f'), 'x');
  }

  const result = backupAndClearCaches(join(root, 'backup'), userData);
  assert.deepEqual(result.map((r) => r.rel), GPU_CACHE_DIRS);
  assert.ok(result.every((r) => r.files === 1 && !r.error));
});

test('dirStats：递归统计文件数与字节', (t) => {
  const dir = tmp(t);
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(join(dir, 'a', 'f1'), Buffer.alloc(10));
  writeFileSync(join(dir, 'a', 'b', 'f2'), Buffer.alloc(5));

  const s = dirStats(dir);
  assert.equal(s.files, 2);
  assert.equal(s.bytes, 15);
});

test('dirStats：目录不存在时返回 0 而不是抛', (t) => {
  const dir = tmp(t);
  const s = dirStats(join(dir, 'nope'));
  assert.deepEqual(s, { files: 0, bytes: 0 });
});
