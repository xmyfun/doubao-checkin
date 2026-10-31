/**
 * 状态判定 —— 纯函数，不碰网络、不碰 CDP。
 *
 * 单独抽出来是为了能单测：四种真实 DOM 结构作为输入写在 test/state.test.mjs 里，
 * 官方改版时先补一种结构再改代码，改错了测试会拦住。
 *
 * 判定原则：不认识的结构一律 UNKNOWN，绝不当成"应该点"。
 * 猜错的代价不是少领 200，是在异常状态下反复调写接口。
 */

export const VERDICT = {
  DONE: 'DONE',         // 今日已签到
  PENDING: 'PENDING',   // 未签到，按钮可点
  AUTH_FAIL: 'AUTH_FAIL', // 未登录
  UNKNOWN: 'UNKNOWN',   // 找不到卡片 / 结构不认识
};

/**
 * @param {object} s  页面快照
 * @param {object} cfg anchors 配置
 * @returns {'DONE'|'PENDING'|'AUTH_FAIL'|'UNKNOWN'}
 */
export function judge(s, cfg) {
  if (!s) return VERDICT.UNKNOWN;

  // 整页都是登录提示、又找不到卡片 → 登录态没了
  if (s.loginPrompt && !s.found) return VERDICT.AUTH_FAIL;

  // 找不到卡片：可能活动下线、也可能页面没加载完，都不猜
  if (!s.found) return VERDICT.UNKNOWN;

  // 已签到的第一判据：对勾标记
  if (s.hasRewarded) return VERDICT.DONE;

  // 有可点的签到按钮 → 未签到
  //
  // 连 flags 一起重建：只取 .source 会把 i 之类的标志丢掉，配置改成大小写不敏感时
  // 会静默失效（文案对不上，全都判成 UNKNOWN）。
  if (
    s.buttonText &&
    new RegExp(cfg.pendingTextPattern.source, cfg.pendingTextPattern.flags).test(s.buttonText) &&
    s.buttonDisabled !== true
  ) {
    return VERDICT.PENDING;
  }

  // 按钮被禁用，可能是"活动未开始"或"已领完"，都不该点
  if (s.buttonText && s.buttonDisabled === true) return VERDICT.UNKNOWN;

  // 卡片在但既没按钮也没对勾 —— 结构变了，不猜
  return VERDICT.UNKNOWN;
}

/** 该不该发写请求 */
export function shouldClaim(verdict) {
  return verdict === VERDICT.PENDING;
}
