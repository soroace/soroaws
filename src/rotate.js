const {
  fetchInstances,
  fetchStaticIps,
  detachStaticIp,
  releaseStaticIp,
  allocateStaticIp,
  attachStaticIp,
} = require("./lightsail");
const { pingHost } = require("./checker");
const { notifyIpChange } = require("./notifier");
const { getRegionLimiter } = require("./limiter");
const { log } = require("./logger");
const config = require("./config");

/**
 * 检测指定实例链路，不可达时自动更换 IP
 * @param {string} region - 区域
 * @param {object} client - 该区域的 AWS 客户端
 * @param {object} server - 实例对象
 * @returns {Promise<{server: object, status: "reachable"|"changed"|"failed"|"skipped"}>}
 */
async function checkIp(region, client, server) {
  const host = server.publicIpAddress;
  const instanceState = server.state?.name || "未知";

  // 已停止/无公网 IP 的实例 Ping 必然失败，直接跳过，不触发换 IP
  if (!host || instanceState !== "running") {
    log("INFO", `${server.name} 状态为 ${instanceState}${host ? "" : "、无公网 IP"}，跳过检测`);
    return { server, status: "skipped" };
  }

  log("INFO", `正在检查 ${server.name} (${host}) 连通性`);

  let reachable;
  try {
    reachable = await pingHost(host, config.pingTimeout);
  } catch (err) {
    log("ERROR", `${server.name} (${host}) 连通性检测异常: ${err.message}`);
    return { server, status: "failed" };
  }

  if (reachable) {
    log("INFO", `${server.name} (${host}) Ping 通，跳过本轮检测`);
    return { server, status: "reachable" };
  }

  log("WARN", `${server.name} (${host}) 持续 ${config.pingTimeout} 秒 Ping 无回复`);
  log("INFO", `${server.name} (${host}) 判定为不可达，开始更换 IP`);

  try {
    // 换 IP 操作经区域限制器排队执行，控制同时进行的更换数量
    const runRotate = getRegionLimiter(client);
    await runRotate(async () => {
      if (server.isStaticIp) {
        await rotateStaticIp(region, client, server);
      } else {
        await allocateAndAttach(region, client, server);
      }
    });
    return { server, status: "changed" };
  } catch (err) {
    log("ERROR", `${server.name} (${host}) IP更换失败: ${err.message}`);
    return { server, status: "failed" };
  }
}

/**
 * 处理已有静态 IP 的实例：解绑旧 IP → 释放旧 IP → 分配新 IP → 绑定新 IP
 */
async function rotateStaticIp(region, client, server) {
  log("INFO", "正在获取区域所有静态 IP 列表");
  const staticIps = await fetchStaticIps(client);
  log("INFO", "获取区域所有静态 IP 列表成功");

  const oldIp = server.publicIpAddress;
  const activeStaticIpItem = staticIps.find(
    (item) => item.ipAddress === oldIp
  );

  if (activeStaticIpItem) {
    log("INFO", `正在解绑静态 IP: ${activeStaticIpItem.name} (${activeStaticIpItem.ipAddress})`);
    await detachStaticIp(client, activeStaticIpItem.name);
    log("INFO", "解绑成功");

    log("INFO", `正在释放静态 IP: ${activeStaticIpItem.name} (${activeStaticIpItem.ipAddress})`);
    await releaseStaticIp(client, activeStaticIpItem.name);
    log("INFO", "释放静态 IP 成功");
  } else {
    log("INFO", `${oldIp} 未找到对应静态 IP，直接分配新 IP`);
  }

  await allocateAndAttach(region, client, server);
}

/**
 * 分配新静态 IP 并绑定到实例
 * 成功返回 { oldIp, newIp }，失败抛出异常（并发送失败告警通知）
 */
async function allocateAndAttach(region, client, server) {
  const oldIp = server.publicIpAddress;
  const staticIpName = `${server.name}-${Date.now()}`;

  log("INFO", `正在创建新的静态 IP`);
  try {
    await allocateStaticIp(client, staticIpName);
  } catch (err) {
    log("ERROR", `创建静态 IP 失败: ${err.message}`);
    await notifyIpChange({
      instanceName: server.name,
      region,
      oldIp,
      newIp: "-",
      success: false,
      reason: err.message,
    });
    throw err;
  }
  log("INFO", "创建静态 IP 成功！");

  log("INFO", `正在绑定静态 IP ${staticIpName} 到实例 ${server.name}`);
  try {
    await attachStaticIp(client, server.name, staticIpName);
  } catch (err) {
    log("ERROR", `绑定静态 IP 失败: ${err.message}`);
    // 回滚：释放刚分配但未绑定的静态 IP，避免产生闲置费用
    try {
      await releaseStaticIp(client, staticIpName);
      log("INFO", `已回滚释放未绑定的静态 IP: ${staticIpName}`);
    } catch (releaseErr) {
      log("ERROR", `回滚释放静态 IP ${staticIpName} 失败: ${releaseErr.message}`);
    }
    await notifyIpChange({
      instanceName: server.name,
      region,
      oldIp,
      newIp: "-",
      success: false,
      reason: err.message,
    });
    throw err;
  }

  log("INFO", "绑定新 IP 成功！");

  // 获取新 IP 的实际地址（查询实例最新公网 IP），失败时以 "-" 兜底
  let newIp = "-";
  try {
    const servers = await fetchInstances(client);
    const matched = servers.find((s) => s.name === server.name);
    if (matched && matched.publicIpAddress) {
      newIp = matched.publicIpAddress;
    }
  } catch (err) {
    log("WARN", `获取新 IP 地址失败，请到 AWS 控制台确认: ${err.message}`);
  }

  await notifyIpChange({
    instanceName: server.name,
    region,
    oldIp,
    newIp,
  });
}

module.exports = { checkIp, rotateStaticIp, allocateAndAttach };
