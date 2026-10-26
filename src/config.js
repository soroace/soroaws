const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { loadAccounts } = require("./accounts");

const accountsResult = loadAccounts(process.env.AWS_ACCOUNTS_FILE);

const config = {
  // AWS 账号（accounts.json），每个账号可配置多个区域
  accounts: accountsResult.accounts,
  accountsFile: accountsResult.file,
  accountsErrors: accountsResult.errors,

  // 本机 Ping 实例公网 IP 的检测总时长（秒），默认 15（期间持续 Ping，有任一回复即视为可达）
  pingTimeout: parseInt(process.env.PING_TIMEOUT || "15", 10),

  // 检测间隔（分钟），默认 1
  interval: parseFloat(process.env.CHECK_INTERVAL_MIN || "1"),

  // 同一区域并行更换 IP 的最大并发数，默认 2（避免触发 AWS 限流）
  rotateConcurrency: parseInt(process.env.ROTATE_CONCURRENCY || "2", 10),

  // 退出前等待在途操作完成的最长时间（秒），默认 120
  shutdownGraceSec: parseInt(process.env.SHUTDOWN_GRACE_SEC || "120", 10),

  // Server酱 推送 Token（可选，留空不推送）
  serverChanToken: process.env.SERVER_CHAN_TOKEN || "",
};

/**
 * 校验配置是否完整
 * @returns {string[]} 错误信息数组，为空则配置正常
 */
function validateConfig() {
  const errors = [...config.accountsErrors];

  if (config.accounts.length === 0 && config.accountsErrors.length === 0) {
    errors.push("accounts.json 未配置任何账号");
  }

  if (Number.isNaN(config.pingTimeout) || config.pingTimeout < 1) {
    errors.push("PING_TIMEOUT 不是有效的数字");
  }
  if (Number.isNaN(config.interval) || config.interval < 1) {
    errors.push("CHECK_INTERVAL_MIN 必须大于 0");
  }
  if (Number.isNaN(config.rotateConcurrency) || config.rotateConcurrency < 1) {
    errors.push("ROTATE_CONCURRENCY 必须是不小于 1 的整数");
  }
  if (Number.isNaN(config.shutdownGraceSec) || config.shutdownGraceSec < 1) {
    errors.push("SHUTDOWN_GRACE_SEC 必须是不小于 1 的整数");
  }

  return errors;
}

module.exports = config;
module.exports.validateConfig = validateConfig;
