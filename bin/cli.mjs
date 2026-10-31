#!/usr/bin/env node
/**
 * 唯一的 node 入口。
 *
 * 为什么要有这一层（而不是让 doubao-checkin.sh 去判断该跑哪个脚本）：
 *   1. help 只有一份。参数如果散在不同层（shell 层筛一批、node 层认一批），
 *      `--help` 就只能由某一层手写汇总，靠人记得同步 —— 迟早漏。
 *   2. 分发用动态 import：跑签到不加载校准那 500 多行，跑校准不加载签到的 CDP 逻辑。
 *
 * 这一层**不维护参数白名单**。白名单会有两份（这里 + 各模块），迟早不同步，
 * 又回到老问题。cli 只回答"去哪"，参数合不合法由目标模块自己判断
 * （checkin.mjs 遇到不认识的参数会直接退出，退出码 2）。
 *
 * shell 层的三个参数（--which-node / --find-node / --install-node）永远到不了这里：
 * 它们的职责就是"在还没有 node 的时候找 node"，必须在 scripts/doubao-checkin.sh 里处理。
 * 但它们在下面的 help 里照样列出 —— 用户只该看到一份清单。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { HELP } from '../src/help.mjs';

/**
 * 校准接受的选项。导出是为了让测试能验证「help 里出现的每个参数都有人认得」。
 * 不在这里的参数一律由 checkin.mjs 处理。
 */
export const CALIBRATE_FLAGS = ['--calibrate', '--interval', '--idle', '--fallback', '--out'];

/** 必须在 shell 层处理的选项（那时 node 还没找到） */
export const SHELL_FLAGS = ['--which-node', '--find-node', '--install-node', '--all'];

const argv = process.argv.slice(2);

async function dispatch() {
  // help 不看位置：`--log --help` 也应该给帮助，而不是跑签到
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const sub = argv[0];
  if (sub === '--calibrate') {
    const { run } = await import('../src/calibrate.mjs');
    await run(argv.slice(1));
    process.exit(0);
  }

  const { run } = await import('./checkin.mjs');
  await run();
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  dispatch().catch((e) => {
    console.error(`\n[失败] ${e?.message || e}`);
    process.exit(1);
  });
}
