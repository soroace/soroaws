const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");

/** 临时修改配置并自动还原，避免测试之间互相影响 */
function withConfig(patch, fn) {
  const saved = {
    accounts: config.accounts,
    accountsErrors: config.accountsErrors,
    pingTimeout: config.pingTimeout,
    interval: config.interval,
    rotateConcurrency: config.rotateConcurrency,
    shutdownGraceSec: config.shutdownGraceSec,
  };

  if (patch.accounts !== undefined) config.accounts = patch.accounts;
  if (patch.accountsErrors !== undefined) config.accountsErrors = patch.accountsErrors;
  for (const key of ["pingTimeout", "interval", "rotateConcurrency", "shutdownGraceSec"]) {
    if (patch[key] !== undefined) config[key] = patch[key];
  }

  try {
    return fn();
  } finally {
    config.accounts = saved.accounts;
    config.accountsErrors = saved.accountsErrors;
    config.pingTimeout = saved.pingTimeout;
    config.interval = saved.interval;
    config.rotateConcurrency = saved.rotateConcurrency;
    config.shutdownGraceSec = saved.shutdownGraceSec;
  }
}

const validAccount = {
  name: "main",
  credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret" },
  regions: ["ap-northeast-1"],
};

const validNumbers = {
  pingTimeout: 15,
  interval: 1,
  rotateConcurrency: 2,
  shutdownGraceSec: 120,
};

test("账号配置错误会透传到校验结果", () => {
  const errors = withConfig(
    { accounts: [], accountsErrors: ["无法读取账号配置文件"], ...validNumbers },
    () => config.validateConfig()
  );

  assert.ok(errors.some((e) => e.includes("无法读取账号配置文件")));
});

test("数值配置非法时报错", () => {
  const errors = withConfig(
    {
      accounts: [validAccount],
      accountsErrors: [],
      pingTimeout: 0,
      interval: 0,
      rotateConcurrency: 0,
      shutdownGraceSec: 0,
    },
    () => config.validateConfig()
  );

  assert.ok(errors.some((e) => e.includes("PING_TIMEOUT")));
  assert.ok(errors.some((e) => e.includes("CHECK_INTERVAL_MIN")));
  assert.ok(errors.some((e) => e.includes("ROTATE_CONCURRENCY")));
  assert.ok(errors.some((e) => e.includes("SHUTDOWN_GRACE_SEC")));
});

test("合法配置通过校验", () => {
  const errors = withConfig(
    { accounts: [validAccount], accountsErrors: [], ...validNumbers },
    () => config.validateConfig()
  );

  assert.deepEqual(errors, []);
});

test("没有账号且无解析错误时仍报错", () => {
  const errors = withConfig(
    { accounts: [], accountsErrors: [], ...validNumbers },
    () => config.validateConfig()
  );

  assert.ok(errors.some((e) => e.includes("未配置任何账号")));
});

test("全部账号禁用时报错", () => {
  const errors = withConfig(
    {
      accounts: [{ ...validAccount, enabled: false }],
      accountsErrors: [],
      ...validNumbers,
    },
    () => config.validateConfig()
  );

  assert.ok(errors.some((e) => e.includes("没有启用的账号")));
});
