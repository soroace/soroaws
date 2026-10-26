const {
  fetchInstances,
  fetchStaticIps,
  detachStaticIp,
  releaseStaticIp,
  allocateStaticIp,
  attachStaticIp,
} = require("./lightsail");
const { pingHost, probeTcpPorts } = require("./checker");
const { classify, nextFailureStreak, VERDICT } = require("./detector");
const { notifyIpChange } = require("./notifier");
const { getRegionLimiter } = require("./limiter");
const { log } = require("./logger");
const config = require("./config");
const { DEFAULT_CHECK } = require("./accounts");

// TCP 连续失败轮次（key = 账号|区域|实例名），跨轮保存在内存
const tcpFailureStreaks = new Map();

/**
 * 清理已不存在实例的连续失败计数，避免 Map 无限增长
 * @param {string[]} activeKeys - 本轮存在的实例 key
 */
function pruneTcpFailureStreaks(activeKeys) {
  const active = new Set(activeKeys);
  for (const key of tcpFailureStreaks.keys()) {
    if (!active.has(key)) tcpFailureStreaks.delete(key);
  }
}

// 默认依赖（测试时可注入替身，避免真实网络与 AWS 调用）
const DEFAULT_DEPS = {
  pingHost,
  probeTcpPorts,
  rotateStaticIp,
  allocateAndAttach,
  getRegionLimiter,
  fetchInstances,
  fetchStaticIps,
  detachStaticIp,
  releaseStaticIp,
  allocateStaticIp,
  attachStaticIp,
  notifyIpChange,
  log,
};

/**
 * 执行换 IP（经区域限流器排队）
 */
async function rotateIp(account, region, client, server, label, host, deps) {
  try {
    const runRotate = deps.getRegionLimiter(client);
    await runRotate(async () => {
      if (server.isStaticIp) {
        await deps.rotateStaticIp(account, region, client, server, deps);
      } else {
        await deps.allocateAndAttach(account, region, client, server, deps);
      }
    });
    return { server, status: "changed" };
  } catch (err) {
    deps.log("ERROR", `${label} (${host}) IP更换失败: ${err.message}`);
    return { server, status: "failed" };
  }
}

/**
 * 检测指定实例链路，不可达时自动更换 IP
 * 支持纯 ping 与 ping+tcp 两种检测方式（账号的 check 配置）
 * @param {object} accountConfig - 账号配置（含 name 与 check）
 * @param {string} region - 区域
 * @param {object} client - 该账号/区域的 AWS 客户端
 * @param {object} server - 实例对象
 * @param {object} [overrides] - 依赖覆盖（测试用）
 * @returns {Promise<{server: object, status: "reachable"|"changed"|"failed"|"skipped"}>}
 */
async function checkIp(accountConfig, region, client, server, overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const account = accountConfig.name;
  const check = accountConfig.check || DEFAULT_CHECK;
  const host = server.publicIpAddress;
  const instanceState = server.state?.name || "未知";
  const label = `${account}/${server.name}`;
  const key = `${account}|${region}|${server.name}`;

  // 已停止/无公网 IP 的实例 Ping 必然失败，直接跳过，不触发换 IP
  if (!host || instanceState !== "running") {
    deps.log(
      "INFO",
      `${label} 状态为 ${instanceState}${host ? "" : "、无公网 IP"}，跳过检测`
    );
    return { server, status: "skipped" };
  }

  deps.log("INFO", `正在检查 ${label} (${host}) 连通性`);

  let pingReachable;
  try {
    pingReachable = await deps.pingHost(host, config.pingTimeout);
  } catch (err) {
    deps.log("ERROR", `${label} (${host}) 连通性检测异常: ${err.message}`);
    return { server, status: "failed" };
  }

  // 纯 ping 模式：与原行为完全一致
  if (check.mode === "ping") {
    if (pingReachable) {
      deps.log("INFO", `${label} (${host}) Ping 通，跳过本轮检测`);
      return { server, status: "reachable" };
    }

    deps.log("WARN", `${label} (${host}) 持续 ${config.pingTimeout} 秒 Ping 无回复`);
    deps.log("INFO", `${label} (${host}) 判定为不可达，开始更换 IP`);
    tcpFailureStreaks.delete(key);
    return rotateIp(account, region, client, server, label, host, deps);
  }

  // ping+tcp 模式：ping 不通时沿用原逻辑（直接换 IP）
  if (!pingReachable) {
    deps.log("WARN", `${label} (${host}) 持续 ${config.pingTimeout} 秒 Ping 无回复`);
    deps.log("INFO", `${label} (${host}) 判定为不可达，开始更换 IP`);
    tcpFailureStreaks.delete(key);
    return rotateIp(account, region, client, server, label, host, deps);
  }

  let tcpResults;
  try {
    tcpResults = await deps.probeTcpPorts(host, check.ports, check.tcpTimeoutMs);
  } catch (err) {
    deps.log("ERROR", `${label} (${host}) TCP 探测异常，本轮不换 IP: ${err.message}`);
    return { server, status: "reachable" };
  }

  const verdict = classify({ pingReachable: true, tcpResults });

  if (verdict === VERDICT.OK) {
    tcpFailureStreaks.delete(key);
    deps.log("INFO", `${label} (${host}) Ping 通，TCP 正常，跳过本轮检测`);
    return { server, status: "reachable" };
  }

  if (verdict === VERDICT.REFUSED) {
    tcpFailureStreaks.delete(key);
    deps.log(
      "WARN",
      `${label} (${host}) Ping 通但 TCP(${check.ports.join(",")}) 全部被拒绝（服务未监听？），不换 IP`
    );
    return { server, status: "reachable" };
  }

  // 疑似 TCP 层封锁：累计连续轮次
  const streakState = nextFailureStreak(tcpFailureStreaks.get(key) || 0, verdict, check);
  tcpFailureStreaks.set(key, streakState.streak);
  deps.log(
    "WARN",
    `${label} (${host}) Ping 通但 TCP(${check.ports.join(",")}) 无响应（第 ${streakState.streak}/${check.confirmRounds} 轮）`
  );

  if (!streakState.shouldRotate) {
    deps.log(
      "INFO",
      check.rotateOnTcpDown
        ? "未达到连续失败阈值，本轮不换 IP"
        : "未开启 check.rotateOnTcpDown，仅记录不换 IP"
    );
    return { server, status: "reachable" };
  }

  deps.log(
    "INFO",
    `${label} (${host}) 连续 ${streakState.streak} 轮 TCP 层不可达，开始更换 IP`
  );
  tcpFailureStreaks.delete(key);
  return rotateIp(account, region, client, server, label, host, deps);
}

/**
 * 处理已有静态 IP 的实例：解绑旧 IP → 释放旧 IP → 分配新 IP → 绑定新 IP
 * @param {object} [deps] - 依赖覆盖（测试用）
 */
async function rotateStaticIp(account, region, client, server, deps = DEFAULT_DEPS) {
  const label = `${account}/${server.name}`;

  deps.log("INFO", `[${account}/${region}] 正在获取区域所有静态 IP 列表`);
  const staticIps = await deps.fetchStaticIps(client);
  deps.log("INFO", `[${account}/${region}] 获取区域所有静态 IP 列表成功`);

  const oldIp = server.publicIpAddress;
  const activeStaticIpItem = staticIps.find(
    (item) => item.ipAddress === oldIp
  );

  if (activeStaticIpItem) {
    deps.log("INFO", `[${account}/${region}] 正在解绑静态 IP: ${activeStaticIpItem.name} (${activeStaticIpItem.ipAddress})`);
    await deps.detachStaticIp(client, activeStaticIpItem.name);
    deps.log("INFO", `[${account}/${region}] 解绑成功`);

    deps.log("INFO", `[${account}/${region}] 正在释放静态 IP: ${activeStaticIpItem.name} (${activeStaticIpItem.ipAddress})`);
    await deps.releaseStaticIp(client, activeStaticIpItem.name);
    deps.log("INFO", `[${account}/${region}] 释放静态 IP 成功`);
  } else {
    deps.log("INFO", `${label} 的 ${oldIp} 未找到对应静态 IP，直接分配新 IP`);
  }

  await allocateAndAttach(account, region, client, server, deps);
}

/**
 * 分配新静态 IP 并绑定到实例
 * 成功时发送成功通知，失败时发送失败告警并抛出异常
 * @param {object} [deps] - 依赖覆盖（测试用）
 */
async function allocateAndAttach(account, region, client, server, deps = DEFAULT_DEPS) {
  const oldIp = server.publicIpAddress;
  const staticIpName = `${server.name}-${Date.now()}`;

  deps.log("INFO", `[${account}/${region}] 正在创建新的静态 IP`);
  try {
    await deps.allocateStaticIp(client, staticIpName);
  } catch (err) {
    deps.log("ERROR", `[${account}/${region}] 创建静态 IP 失败: ${err.message}`);
    await deps.notifyIpChange({
      account,
      instanceName: server.name,
      region,
      oldIp,
      newIp: "-",
      success: false,
      reason: err.message,
    });
    throw err;
  }
  deps.log("INFO", `[${account}/${region}] 创建静态 IP 成功！`);

  deps.log("INFO", `[${account}/${region}] 正在绑定静态 IP ${staticIpName} 到实例 ${server.name}`);
  try {
    await deps.attachStaticIp(client, server.name, staticIpName);
  } catch (err) {
    deps.log("ERROR", `[${account}/${region}] 绑定静态 IP 失败: ${err.message}`);
    // 回滚：释放刚分配但未绑定的静态 IP，避免产生闲置费用
    try {
      await deps.releaseStaticIp(client, staticIpName);
      deps.log("INFO", `[${account}/${region}] 已回滚释放未绑定的静态 IP: ${staticIpName}`);
    } catch (releaseErr) {
      deps.log("ERROR", `[${account}/${region}] 回滚释放静态 IP ${staticIpName} 失败: ${releaseErr.message}`);
    }
    await deps.notifyIpChange({
      account,
      instanceName: server.name,
      region,
      oldIp,
      newIp: "-",
      success: false,
      reason: err.message,
    });
    throw err;
  }

  deps.log("INFO", `[${account}/${region}] 绑定新 IP 成功！`);

  // 获取新 IP 的实际地址（查询实例最新公网 IP），失败时以 "-" 兜底
  let newIp = "-";
  try {
    const servers = await deps.fetchInstances(client);
    const matched = servers.find((s) => s.name === server.name);
    if (matched && matched.publicIpAddress) {
      newIp = matched.publicIpAddress;
    }
  } catch (err) {
    deps.log("WARN", `[${account}/${region}] 获取新 IP 地址失败，请到 AWS 控制台确认: ${err.message}`);
  }

  await deps.notifyIpChange({
    account,
    instanceName: server.name,
    region,
    oldIp,
    newIp,
  });
}

module.exports = { checkIp, rotateStaticIp, allocateAndAttach, pruneTcpFailureStreaks };
