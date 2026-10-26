// ping + tcp 结果组合判定，以及连续失败轮次的状态推演
// 纯逻辑模块：不发起探测、不读写配置，方便单测

const VERDICT = {
  OK: "ok",
  REFUSED: "refused",
  SUSPICIOUS: "suspicious",
  UNREACHABLE: "unreachable",
};

/**
 * 根据 ping 与 TCP 探测结果给出判定
 * - ping 不通：unreachable（沿用现有“不可达”逻辑）
 * - 未启用 TCP 探测（无结果）：ok
 * - 任一端口握手成功：ok
 * - 端口全部明确拒绝：refused（机器可达，只是服务没开，不应换 IP）
 * - 其余（超时/重置/不可路由等）：suspicious（疑似 TCP 层被封锁）
 * @param {{pingReachable: boolean, tcpResults?: Array<{ok: boolean, reason?: string}>}} sample
 * @returns {"ok"|"refused"|"suspicious"|"unreachable"}
 */
function classify({ pingReachable, tcpResults = [] }) {
  if (!pingReachable) return VERDICT.UNREACHABLE;
  if (tcpResults.length === 0) return VERDICT.OK;
  if (tcpResults.some((result) => result && result.ok)) return VERDICT.OK;
  if (tcpResults.every((result) => result && result.reason === "refused")) {
    return VERDICT.REFUSED;
  }
  return VERDICT.SUSPICIOUS;
}

/**
 * 推演连续失败轮次
 * - 只有 suspicious 会累计
 * - ok / refused / unreachable 一律清零（refused 属于服务问题，不触发换 IP）
 * - rotateOnTcpDown 为 true 且累计达到 confirmRounds 才建议换 IP
 * @param {number} previousStreak - 上一轮的累计轮次
 * @param {string} verdict - classify 的返回值
 * @param {{confirmRounds?: number, rotateOnTcpDown?: boolean}} [options]
 * @returns {{streak: number, shouldRotate: boolean}}
 */
function nextFailureStreak(previousStreak, verdict, options = {}) {
  const { confirmRounds = 2, rotateOnTcpDown = false } = options;

  if (verdict !== VERDICT.SUSPICIOUS) {
    return { streak: 0, shouldRotate: false };
  }

  const streak = (previousStreak || 0) + 1;
  const shouldRotate = rotateOnTcpDown === true && streak >= confirmRounds;

  return { streak, shouldRotate };
}

module.exports = { VERDICT, classify, nextFailureStreak };
