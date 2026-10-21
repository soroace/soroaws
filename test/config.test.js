const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");

/** 临时修改配置并自动还原，避免测试之间互相影响 */
function withConfig(patch, fn) {
  const saved = {
    credentials: { ...config.credentials },
    regions: [...config.regions],
    pingTimeout: config.pingTimeout,
    interval: config.interval,
    rotateConcurrency: config.rotateConcurrency,
    shutdownGraceSec: config.shutdownGraceSec,
  };

  config.credentials = { ...saved.credentials, ...(patch.credentials || {}) };
  config.regions = patch.regions ? [...patch.regions] : saved.regions;
  for (const key of ["pingTimeout", "interval", "rotateConcurrency", "shutdownGraceSec"]) {
    if (patch[key] !== undefined) config[key] = patch[key];
  }

  try {
    return fn();
  } finally {
    config.credentials = saved.credentials;
    config.regions = saved.regions;
    config.pingTimeout = saved.pingTimeout;
    config.interval = saved.interval;
    config.rotateConcurrency = saved.rotateConcurrency;
    config.shutdownGraceSec = saved.shutdownGraceSec;
  }
}

test("缺少 AWS 凭证时报错", () => {
  const errors = withConfig(
    { credentials: { accessKeyId: "", secretAccessKey: "" } },
    () => config.validateConfig()
  );

  assert.ok(errors.some((e) => e.includes("AWS_ACCESS_KEY_ID")));
  assert.ok(errors.some((e) => e.includes("AWS_SECRET_ACCESS_KEY")));
});

test("非法区域名报错", () => {
  const errors = withConfig({ regions: ["ap_northeast_1", "AP-NORTHEAST-1"] }, () =>
    config.validateConfig()
  );

  assert.equal(errors.filter((e) => e.includes("无效区域名")).length, 1);
});

test("合法配置通过校验", () => {
  const errors = withConfig(
    {
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret" },
      regions: ["ap-northeast-1", "ap-southeast-1"],
      pingTimeout: 15,
      interval: 1,
      rotateConcurrency: 2,
      shutdownGraceSec: 120,
    },
    () => config.validateConfig()
  );

  assert.deepEqual(errors, []);
});

test("探测时长/间隔非正数时报错", () => {
  const errors = withConfig({ pingTimeout: 0, interval: 0 }, () => config.validateConfig());

  assert.ok(errors.some((e) => e.includes("PING_TIMEOUT")));
  assert.ok(errors.some((e) => e.includes("CHECK_INTERVAL_MIN")));
});
