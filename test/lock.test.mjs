import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, isLocked, lockPath, setLockDir } from '../src/lock.mjs';

// 锁目录重定向到临时目录：否则单测会直接在项目根目录建 .lock，
// 一旦此刻真有定时任务在跑，双方抢同一把锁，测试就会随机失败。
const DIR = mkdtempSync(join(tmpdir(), 'doubao-lock-test-'));
setLockDir(join(DIR, '.lock'));

test.after(() => {
  releaseLock();
  setLockDir('');
  rmSync(DIR, { recursive: true, force: true });
});

test('锁目录被重定向到临时目录（不会去碰项目根的 .lock）', () => {
  assert.ok(lockPath().startsWith(DIR), `没重定向成功：${lockPath()}`);
});

test('清空重定向后回到默认位置（项目根的 .lock）', () => {
  setLockDir('');
  assert.match(lockPath(), /\/\.lock$/, `默认锁目录应以 .lock 结尾：${lockPath()}`);
  assert.ok(!lockPath().startsWith(DIR), '清空后不该还指向临时目录');
  setLockDir(join(DIR, '.lock'));   // 还原，后面的用例仍用临时目录
});

test('首次能拿到锁', () => {
  releaseLock();
  const r = acquireLock();
  assert.equal(r.ok, true);
  assert.equal(isLocked(), true);
  assert.ok(existsSync(lockPath()));
});

test('同一进程重复拿锁会失败，并报出持有者 pid', () => {
  const r = acquireLock();
  assert.equal(r.ok, false);
  assert.equal(r.holder, process.pid);
});

test('释放后可以再次拿到', () => {
  releaseLock();
  assert.equal(isLocked(), false);
  const r = acquireLock();
  assert.equal(r.ok, true);
  releaseLock();
});

test('僵尸锁（pid 已不存在）会被自动清理', () => {
  releaseLock();
  // 手工造一个"上一个进程被 SIGKILL 后留下的锁"。
  // 999999 远大于 macOS 的 pid 上限（kern.maxproc 约 1 万），不会撞上真实进程。
  mkdirSync(lockPath());
  writeFileSync(join(lockPath(), 'pid'), '999999');

  const r = acquireLock();
  assert.equal(r.ok, true, '僵尸锁应该被清掉并重新获取');
  assert.equal(r.stale, undefined);
  releaseLock();
});
