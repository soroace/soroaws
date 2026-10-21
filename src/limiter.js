const config = require("./config");

/**
 * 创建并发限制器：同一时间最多执行 max 个任务，其余排队等待
 * @param {number} max - 最大并发数
 * @returns {Function} run - (fn) => Promise，fn 的结果/异常原样透传
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    const task = queue.shift();
    active++;
    task.fn()
      .then(task.resolve, task.reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// 每个区域（client）一个独立的限制器：大量实例同时不可达时，
// 换 IP 操作排队执行，避免并发 AWS 调用触发限流
const regionLimiters = new Map();
function getRegionLimiter(client) {
  if (!regionLimiters.has(client)) {
    regionLimiters.set(client, createLimiter(config.rotateConcurrency));
  }
  return regionLimiters.get(client);
}

module.exports = { createLimiter, getRegionLimiter };
