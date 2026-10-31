/**
 * 连续失败熔断 —— 纯函数，只吃 history 记录，不碰网络、不碰文件。
 *
 * 为什么需要它
 *   单次失败不算什么：页面偶发加载慢、网络抖一下、客户端刚起来还没就绪。
 *   但**连续**失败说明这不是偶发 —— 页面改版、客户端异常、登录态失效都会连续失败。
 *   此时继续按小时重试只有一个效果：反复把用户的客户端启动起来再关掉。
 *   2026-10-30 到 10-31 就发生过一次：连续 30 次 UNKNOWN，每小时一次，
 *   每次以 SIGKILL 收尾，持续 31 小时。熔断让它在第 3 次就停下来。
 *
 * 为什么读 history 而不另存状态文件
 *   和缓存判定同一个理由：两份文件记同一件事，迟早不一致。
 *   history.jsonl 本来就是"每次运行的结论"，连续失败是它的一阶导数。
 *
 * 什么算失败
 *   UNKNOWN / FAIL / AUTH_FAIL —— 这三种都表示"这次没签成，而且不是主动放弃"。
 * 什么不算
 *   BUSY    客户端正在跑任务，主动让路，是设计内的行为；
 *   SKIPPED 今天已经签过了，任务早就完成了；
 *   CIRCUIT 熔断本身产生的记录，否则它会把自己越数越多。
 */

/** 成功：连续计数到此为止 */
const OK = new Set(['SUCCESS', 'ALREADY']);

/** 中性：既不清零也不计数 */
const NEUTRAL = new Set(['SKIPPED', 'BUSY', 'CIRCUIT', 'DOCTOR', 'PENDING', 'REPAIR']);

/**
 * @param {object[]} rows  readHistory 的输出（**新的在前**）
 * @param {{threshold:number, cooldownHours:number, now?:number}} opts
 *   threshold=0 表示关闭熔断，永远返回 tripped=false
 * @returns {{tripped:boolean, fails:number, probe:boolean, retryAt:Date|null}}
 *   tripped  现在该拦住
 *   fails    连续失败次数（≤ threshold 时也要，用于日志）
 *   probe    冷却已过、本次放行一次试探（半开状态）
 *   retryAt  什么时候会放行（仅 tripped 时有值）
 */
export function breakerState(rows, { threshold, cooldownHours, now = Date.now() }) {
  if (!threshold || threshold <= 0) {
    return { tripped: false, fails: 0, probe: false, retryAt: null };
  }

  let fails = 0;
  let lastFailAt = null;
  for (const r of rows) {
    if (OK.has(r.result)) break;         // 成功过 → 断了的链子已经接上
    if (NEUTRAL.has(r.result)) continue; // 跳过：不影响连续性的判断
    // dry-run 是"只看不点"的诊断，它的失败不代表签到坏了（比如在沙箱里
    // 根本开不了调试端口）。算进熔断会让一次排查把整天的自动运行停掉。
    if (r.dry_run) continue;
    fails += 1;
    if (lastFailAt === null) lastFailAt = r.at;
  }

  if (fails < threshold || !lastFailAt) {
    return { tripped: false, fails, probe: false, retryAt: null };
  }

  const last = new Date(lastFailAt).getTime();
  if (!Number.isFinite(last)) {
    // at 字段损坏时按"没冷却过"处理：宁可多试一次，也不要因为一条脏记录永久卡住
    return { tripped: false, fails, probe: true, retryAt: null };
  }

  const cooldownMs = Math.max(0, cooldownHours) * 3600_000;
  const elapsed = now - last;

  // 半开：冷却结束就放行一次。成功会清零，失败会重新开始计时。
  // 没有这一条，用户修好客户端之后还得手动删记录才能恢复。
  if (elapsed >= cooldownMs) {
    return { tripped: false, fails, probe: true, retryAt: null };
  }

  return { tripped: true, fails, probe: false, retryAt: new Date(last + cooldownMs) };
}
