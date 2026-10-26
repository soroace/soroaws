const { exec } = require("child_process");
const os = require("os");
const net = require("net");

/**
 * 调用系统 ping 命令检测指定主机（单次）
 * @param {string} host - 目标 IP 地址
 * @param {number} timeout - 单次超时秒数
 * @returns {Promise<boolean>} 是否有回复
 */
function systemPing(host, timeout) {
  return new Promise((resolve) => {
    // 跨平台兼容
    const isWin = os.platform() === "win32";
    const cmd = isWin
      ? `ping -n 1 -w ${timeout * 1000} ${host}`
      : `ping -c 1 -W ${timeout} ${host}`;

    // 防御性超时：正常 ping 会自行退出，异常挂起时强制结束，避免卡死整轮检测
    exec(cmd, { timeout: (timeout + 2) * 1000, killSignal: "SIGKILL" }, (error) => {
      // error 非空表示 ping 不通（退出码非0）或子进程被强杀
      resolve(!error);
    });
  });
}

/**
 * 在给定时间窗口内持续 Ping 主机，有任一次回复即视为可达
 * @param {string} host - 目标 IP 地址
 * @param {number} seconds - 检测总时长（秒）
 * @returns {Promise<boolean>} 是否有回复
 */
async function pingHost(host, seconds) {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    if (await systemPing(host, 5)) {
      return true; // 有回复立即结束，不等到期
    }

    // 还没到截止时间，等 1 秒再试
    if (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return false;
}

/**
 * TCP 探测指定主机端口（单次）
 * @param {string} host - 目标 IP 地址
 * @param {number} port - 目标端口
 * @param {number} [timeoutMs] - 连接超时（毫秒）
 * @returns {Promise<{ok: boolean, reason: string}>} reason: connect/refused/timeout/reset/unreachable/error
 */
function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      resolve(result);
    };

    socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);

    socket.once("connect", () => finish({ ok: true, reason: "connect" }));
    socket.once("timeout", () => finish({ ok: false, reason: "timeout" }));
    socket.once("error", (err) => {
      const code = err && err.code;
      if (code === "ECONNREFUSED") return finish({ ok: false, reason: "refused" });
      if (code === "ECONNRESET") return finish({ ok: false, reason: "reset" });
      if (code === "ETIMEDOUT") return finish({ ok: false, reason: "timeout" });
      if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
        return finish({ ok: false, reason: "unreachable" });
      }
      return finish({ ok: false, reason: "error" });
    });
  });
}

/**
 * 依次探测多个端口，任一成功即提前结束
 * @param {string} host - 目标 IP 地址
 * @param {number[]} ports - 待探测端口
 * @param {number} [timeoutMs] - 单端口连接超时（毫秒）
 * @param {Function} [probe] - 探测函数（默认 tcpProbe，测试时可注入）
 * @returns {Promise<Array<{port: number, ok: boolean, reason: string}>>}
 */
async function probeTcpPorts(host, ports, timeoutMs = 3000, probe = tcpProbe) {
  const results = [];

  for (const port of ports) {
    const result = await probe(host, port, timeoutMs);
    results.push({ port, ...result });
    if (result.ok) break;
  }

  return results;
}

module.exports = { systemPing, pingHost, tcpProbe, probeTcpPorts };
