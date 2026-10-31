/**
 * help 与代码不同步的防护网。
 *
 * 这件事人工维护过两次，漏过两次：`--calibrate` 加进脚本后 help 里没有它，
 * 用户找不到；主程序加了参数，脚本层的 help 又没跟上。所以用测试锁住：
 *   · help 里出现的每个参数，必须真的有人认得（否则是写错了或早删了）
 *   · 代码里认的每个参数，必须出现在 help 里（否则用户不知道它存在）
 *
 * 参数分散在三个地方，各有各的道理，这里不合并成一份（那会破坏分层），
 * 只用测试保证三份清单对得上：
 *   bin/checkin.mjs          —— KNOWN 集合
 *   bin/cli.mjs              —— CALIBRATE_FLAGS / SHELL_FLAGS
 *   scripts/install-node.sh 等 —— 各脚本自己的 case 分支
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, CALIBRATE_FLAGS, SHELL_FLAGS } from '../bin/cli.mjs';
import { EXIT } from '../src/app-profile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** help 里提到的所有 --xxx（忽略 --log[=N] 这种带方括号的写法） */
function flagsInHelp() {
  return new Set([...HELP.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
}

/** checkin.mjs 的 KNOWN 集合，从源码里抽（不能 import：它有顶层副作用） */
function checkinKnown() {
  const src = read('bin/checkin.mjs');
  const m = src.match(/const KNOWN = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'bin/checkin.mjs 里找不到 KNOWN 定义，测试已失效，请同步更新');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((s) => s.startsWith('-')));
}

/** install-launchd.sh 里自己处理的分支（--status / --uninstall 等） */
function installLaunchdFlags() {
  const src = read('scripts/install-launchd.sh');
  return new Set([...src.matchAll(/^\s*(?:[a-z-]+\|)*(--[a-z-]+)(?:\|--[a-z-]+)*\)/gm)].map((m) => m[1]));
}

test('help 里的每个参数都有人认得', () => {
  const known = new Set([
    ...checkinKnown(),
    ...CALIBRATE_FLAGS,
    ...SHELL_FLAGS,
    ...installLaunchdFlags(),
  ]);
  const missing = [...flagsInHelp()].filter((f) => !known.has(f));
  assert.deepEqual(missing, [],
    `help 里提到了但没有任何代码认得：${missing.join(' ')}\n`
    + '（拼错了，或者参数已经删了但 help 没删）');
});

test('代码认的每个参数都出现在 help 里', () => {
  const inHelp = flagsInHelp();
  // 只比长选项：flagsInHelp 按 --xxx 抽，短选项单独看
  const hidden = [...checkinKnown()].filter((f) => f.startsWith('--') && !inHelp.has(f));
  assert.deepEqual(hidden, [], `这些参数在代码里认、但 help 里没写，用户不会知道：${hidden.join(' ')}`);
  assert.ok(checkinKnown().has('-h'), 'checkin.mjs 应当继续认得 -h');
  assert.match(HELP, /-h/, 'help 里没提 -h');
});

test('校准和 shell 层的参数都写进了 help', () => {
  const inHelp = flagsInHelp();
  for (const f of [...CALIBRATE_FLAGS, ...SHELL_FLAGS]) {
    assert.ok(inHelp.has(f), `help 里缺少 ${f}`);
  }
});

test('help 里不出现内部文档路径', () => {
  // 用户拿到的是发布出去的仓库，仓库里没有内部设计文档。help 里让人去翻那些文件，
  // 等于给了一条走不通的路。
  assert.doesNotMatch(HELP, /(?:^|[\s(])(?:dev|docs)\/[a-z0-9-]/i);
});

/**
 * 退出码是脚本 / 定时任务唯一的判断依据，写错一个名字不会报错：
 * `EXIT.XXX` 取到 undefined，异常里带着 undefined 一路传到
 * `e.exitCode || EXIT.FAIL`，最后静默变成 1 —— 看起来"就是失败了"，
 * 实际原因被抹平，按退出码分支的脚本会走错路。所以把它钉住。
 */
test('代码里引用的每个 EXIT.X 都真的定义了', () => {
  const files = ['bin', 'src'].flatMap((dir) => readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(dir, f)));
  const bad = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/\bEXIT\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      if (!(m[1] in EXIT)) bad.push(`${f}: EXIT.${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `这些引用取到的是 undefined，退出码会退化成 1：\n${bad.join('\n')}`);
});

test('退出码数值固定：0 成功、1 失败，2 以上各自区分', () => {
  // 数字一旦发布就会被外面的脚本依赖，不能悄悄改含义
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.FAIL, 1);
  assert.ok(EXIT.APP >= 2 && EXIT.AUTH >= 2 && EXIT.UNKNOWN >= 2);
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, '不能有两个码撞成同一个数字');
});

test('参数分层：node 相关的三个留在 shell，其余交给 cli', () => {
  const shellSrc = read('scripts/doubao-checkin.sh');
  for (const f of ['--which-node', '--find-node', '--install-node']) {
    assert.ok(shellSrc.includes(`"${f}"`), `${f} 必须由 scripts/doubao-checkin.sh 处理（那时还没有 node）`);
  }
  // --help 不该再由 shell 层手写：它必须转给 cli.mjs，否则就有两份 help
  assert.doesNotMatch(shellSrc, /cat <<'HELP'/, 'scripts/doubao-checkin.sh 里又出现了手写 help');
  assert.match(shellSrc, /bin\/cli\.mjs/, 'scripts/doubao-checkin.sh 应当 exec bin/cli.mjs');
});

// ── 主程序的命令行契约 ──
//
// bin/checkin.mjs 有顶层副作用（读参数、连客户端），不能 import，只能跑子进程。
// 这两个参数都在「碰客户端之前」就返回，所以跑起来是安全的。

const CONF = join(ROOT, 'config.conf');

/**
 * 跑一次 bin/checkin.mjs。
 * 首次运行会自动生成 config.conf，CI 上没有这个文件 —— 跑完清掉，别污染工作树。
 */
function runCheckin(args) {
  const existed = existsSync(CONF);
  const r = spawnSync(process.execPath, [join(ROOT, 'bin/checkin.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 20000,
  });
  if (!existed && existsSync(CONF)) rmSync(CONF);
  return r;
}

test('--help：退出码 0，主要参数都列了出来', () => {
  const r = runCheckin(['--help']);
  assert.equal(r.status, 0, `--help 应该正常退出，stderr：${r.stderr}`);
  for (const f of ['--dry-run', '--doctor', '--log', '--create-config', '--calibrate']) {
    assert.ok(r.stdout.includes(f), `help 里缺少 ${f}`);
  }
});

test('--version：输出纯版本号，且与 package.json 完全一致', () => {
  // 版本号只该有一个来源（package.json）。这条用例把"两处不一致"变成红灯 ——
  // 顺带锁住输出格式：不带工具名、不带 v 前缀，否则 `$(… --version)` 没法直接比较。
  const r = runCheckin(['--version']);
  assert.equal(r.status, 0, `--version 应该正常退出，stderr：${r.stderr}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(r.stdout.trim(), pkg.version);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, '必须是 X.Y.Z，不带 v 前缀');
});

test('未知参数：退出码 2 并列出可用参数（不猜、不继续跑）', () => {
  const r = runCheckin(['--definitely-not-a-flag']);
  assert.equal(r.status, 2, `未知参数必须退出 2，实际 ${r.status}`);
  assert.match(r.stderr, /未知参数/);
  assert.match(r.stderr, /--dry-run/, '应当顺便告诉用户有哪些参数能用');
});

test('--log：空历史也正常退出（不能崩在"还没有记录"上）', () => {
  const r = runCheckin(['--log']);
  assert.equal(r.status, 0, `--log 应该正常退出，stderr：${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Error|错误/, '空历史是正常情况，不该报错');
});
