#!/usr/bin/env node
/**
 * 安装向导用的轻量自检入口：**只发一条测试消息**，不碰豆包、不跑签到。
 *
 * 输出给 scripts/install-launchd.sh 解析（三选一）：
 *   SKIP          没配 notify.feishuWebhook，也没通过 --url 传地址
 *   OK  …         发送成功
 *   ERR <原因>    发送失败（不带完整地址）
 *
 * 为什么不复用 `doubao-checkin.sh --test-webhook`：
 *   · 那个开关附着在**一次真实签到**上：会拉起/重启客户端，推的内容取决于页面状态。
 *     自检只想验证「通知通道通不通」，不该把豆包的状态卷进来。
 *   · 向导本身确实会因为 RunAtLoad 顺带跑一次签到，但那是 bootstrap 之后的
 *     --quiet 定时任务（按过滤规则推送），既不是一条内容固定的自检消息，
 *     也来不及在向导里给一句「已推送请到群里查看」。
 *   · 这条消息讲的是安装：安装完成、主机名、签到脚本绝对路径 —— 都与签到结果无关。
 *
 * 参数（由向导传，或手工调用）：
 *   --url=<地址>      只用于这条测试消息，不改 config.conf
 *   --script=<路径>   plist 里实际执行的签到脚本绝对路径
 *   --host=<主机名>   不传用 os.hostname()
 */

import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWebhookUrl, send, buildText, maskUrl, parseTestArgs } from '../src/webhook.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseTestArgs(process.argv.slice(2));
if (args.error) {
  console.log(`ERR ${args.error}`);
  process.exit(1);
}

const url = args.url || readWebhookUrl();
if (!url) {
  console.log('SKIP');
  process.exit(0);
}

const text = buildText({}, 'install', {
  host: args.host || hostname(),
  scriptPath: args.scriptPath || join(ROOT, 'scripts/doubao-checkin.sh'),
});

const r = await send(url, text);
if (r.ok) {
  console.log(`OK 已推送测试消息到 ${maskUrl(url)}`);
  process.exit(0);
}

console.log(`ERR ${r.reason}（${maskUrl(url)}）`);
process.exit(1);
