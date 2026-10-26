const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeAccounts, loadAccounts } = require("../src/accounts");

function writeTempJson(content) {
  const file = path.join(
    os.tmpdir(),
    `soroaws-accounts-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("合法多账号配置归一化（区域去重、两端空白清理）", () => {
  const { accounts, errors } = normalizeAccounts([
    {
      name: "main",
      accessKeyId: "A1",
      secretAccessKey: "S1",
      regions: ["ap-northeast-1", "ap-northeast-1", " ap-southeast-1 "],
    },
    {
      name: "backup",
      accessKeyId: "A2",
      secretAccessKey: "S2",
      regions: ["ap-northeast-1"],
    },
  ]);

  assert.deepEqual(errors, []);
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts[0].regions, ["ap-northeast-1", "ap-southeast-1"]);
  assert.deepEqual(accounts[1].regions, ["ap-northeast-1"]);
});

test("不同账号使用同一区域是合法的", () => {
  const { errors } = normalizeAccounts([
    { name: "a", accessKeyId: "A", secretAccessKey: "S", regions: ["us-east-1"] },
    { name: "b", accessKeyId: "A", secretAccessKey: "S", regions: ["us-east-1"] },
  ]);

  assert.deepEqual(errors, []);
});

test("非数组或空数组报错", () => {
  assert.ok(normalizeAccounts({}).errors.length > 0);
  assert.ok(normalizeAccounts([]).errors.length > 0);
});

test("账号名重复报错", () => {
  const { errors } = normalizeAccounts([
    { name: "dup", accessKeyId: "A", secretAccessKey: "S", regions: ["us-east-1"] },
    { name: "dup", accessKeyId: "A", secretAccessKey: "S", regions: ["us-east-1"] },
  ]);

  assert.ok(errors.some((e) => e.includes("重复")));
});

test("缺少凭证报错", () => {
  const { errors } = normalizeAccounts([
    { name: "main", regions: ["us-east-1"] },
  ]);

  assert.ok(errors.some((e) => e.includes("accessKeyId")));
  assert.ok(errors.some((e) => e.includes("secretAccessKey")));
});

test("非法区域名报错", () => {
  const { errors } = normalizeAccounts([
    {
      name: "main",
      accessKeyId: "A",
      secretAccessKey: "S",
      regions: ["ap_northeast_1", "AP-NORTHEAST-1"],
    },
  ]);

  assert.ok(errors.some((e) => e.includes("无效区域名")));
});

test("loadAccounts 能读取合法文件", () => {
  const file = writeTempJson(
    JSON.stringify([
      { name: "main", accessKeyId: "A", secretAccessKey: "S", regions: ["ap-northeast-1"] },
    ])
  );

  try {
    const { accounts, errors } = loadAccounts(file);
    assert.deepEqual(errors, []);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].name, "main");
  } finally {
    fs.unlinkSync(file);
  }
});

test("loadAccounts 对缺失文件返回错误", () => {
  const { accounts, errors } = loadAccounts(
    path.join(os.tmpdir(), `soroaws-missing-${Date.now()}.json`)
  );

  assert.equal(accounts.length, 0);
  assert.ok(errors[0].includes("无法读取"));
});

test("loadAccounts 对非法 JSON 返回错误", () => {
  const file = writeTempJson("{ not json");

  try {
    const { errors } = loadAccounts(file);
    assert.ok(errors[0].includes("JSON"));
  } finally {
    fs.unlinkSync(file);
  }
});

test("loadAccounts 兼容带 UTF-8 BOM 的文件", () => {
  const file = writeTempJson(
    "\uFEFF" +
      JSON.stringify([
        { name: "main", accessKeyId: "A", secretAccessKey: "S", regions: ["ap-northeast-1"] },
      ])
  );

  try {
    const { accounts, errors } = loadAccounts(file);
    assert.deepEqual(errors, []);
    assert.equal(accounts.length, 1);
  } finally {
    fs.unlinkSync(file);
  }
});

test("enabled 缺省视为启用", () => {
  const { accounts } = normalizeAccounts([
    { name: "main", accessKeyId: "A", secretAccessKey: "S", regions: ["us-east-1"] },
  ]);

  assert.equal(accounts[0].enabled, true);
});

test("禁用账号允许空凭证和空区域", () => {
  const { accounts, errors } = normalizeAccounts([{ name: "legacy", enabled: false }]);

  assert.deepEqual(errors, []);
  assert.equal(accounts[0].enabled, false);
  assert.deepEqual(accounts[0].regions, []);
});

test("启用账号缺少凭证和区域仍报错", () => {
  const { errors } = normalizeAccounts([{ name: "on", enabled: true }]);

  assert.ok(errors.some((e) => e.includes("accessKeyId")));
  assert.ok(errors.some((e) => e.includes("secretAccessKey")));
  assert.ok(errors.some((e) => e.includes("regions")));
});

test("enabled 非布尔值报错", () => {
  const { errors } = normalizeAccounts([
    {
      name: "x",
      enabled: "false",
      accessKeyId: "A",
      secretAccessKey: "S",
      regions: ["us-east-1"],
    },
  ]);

  assert.ok(errors.some((e) => e.includes("enabled")));
});

test("禁用账号提供非法区域仍报错", () => {
  const { errors } = normalizeAccounts([
    { name: "x", enabled: false, regions: ["NOT_A_REGION"] },
  ]);

  assert.ok(errors.some((e) => e.includes("无效区域名")));
});

test("check 缺省为纯 ping", () => {
  const { accounts } = normalizeAccounts([
    { name: "m", accessKeyId: "A", secretAccessKey: "S", regions: ["us-east-1"] },
  ]);

  assert.deepEqual(accounts[0].check, {
    mode: "ping",
    ports: [],
    tcpTimeoutMs: 3000,
    confirmRounds: 2,
    rotateOnTcpDown: false,
  });
});

test("check 配置正常解析（端口去重）", () => {
  const { accounts, errors } = normalizeAccounts([
    {
      name: "m",
      accessKeyId: "A",
      secretAccessKey: "S",
      regions: ["us-east-1"],
      check: {
        mode: "ping+tcp",
        ports: [22, 22, 443],
        tcpTimeoutMs: 2000,
        confirmRounds: 3,
        rotateOnTcpDown: true,
      },
    },
  ]);

  assert.deepEqual(errors, []);
  assert.deepEqual(accounts[0].check, {
    mode: "ping+tcp",
    ports: [22, 443],
    tcpTimeoutMs: 2000,
    confirmRounds: 3,
    rotateOnTcpDown: true,
  });
});

test("ping+tcp 未配置 ports 报错", () => {
  const { errors } = normalizeAccounts([
    {
      name: "m",
      accessKeyId: "A",
      secretAccessKey: "S",
      regions: ["us-east-1"],
      check: { mode: "ping+tcp" },
    },
  ]);

  assert.ok(errors.some((e) => e.includes("check.ports")));
});

test("check 非法字段报错", () => {
  const { errors } = normalizeAccounts([
    {
      name: "m",
      accessKeyId: "A",
      secretAccessKey: "S",
      regions: ["us-east-1"],
      check: {
        mode: "tcp",
        ports: [0, 70000],
        tcpTimeoutMs: 99999,
        confirmRounds: 0,
        rotateOnTcpDown: "yes",
      },
    },
  ]);

  assert.ok(errors.some((e) => e.includes("check.mode")));
  assert.ok(errors.some((e) => e.includes("check.ports")));
  assert.ok(errors.some((e) => e.includes("tcpTimeoutMs")));
  assert.ok(errors.some((e) => e.includes("confirmRounds")));
  assert.ok(errors.some((e) => e.includes("rotateOnTcpDown")));
});
