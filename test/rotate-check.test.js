const test = require("node:test");
const assert = require("node:assert/strict");
const { checkIp } = require("../src/rotate");

const CHECK = {
  mode: "ping+tcp",
  ports: [22],
  tcpTimeoutMs: 1000,
  confirmRounds: 2,
  rotateOnTcpDown: true,
};

function makeAccount(overrides = {}) {
  return { name: "main", check: { ...CHECK, ...overrides } };
}

function makeServer(name, isStaticIp = false) {
  return {
    name,
    state: { name: "running" },
    publicIpAddress: "1.2.3.4",
    isStaticIp,
  };
}

function makeDeps({ pingResults = [true], tcpResults, rotateError } = {}) {
  const calls = { ping: 0, tcp: 0, rotate: 0 };
  const pings = [...pingResults];

  const rotate = async () => {
    calls.rotate++;
    if (rotateError) throw rotateError;
  };

  const deps = {
    pingHost: async () => {
      calls.ping++;
      return pings.length > 0 ? pings.shift() : true;
    },
    probeTcpPorts: async () => {
      calls.tcp++;
      return tcpResults || [{ port: 22, ok: true, reason: "connect" }];
    },
    rotateStaticIp: rotate,
    allocateAndAttach: rotate,
    getRegionLimiter: () => (fn) => fn(),
    log: () => {},
  };

  return { deps, calls };
}

test("ping 不通时触发换 IP", async () => {
  const { deps, calls } = makeDeps({ pingResults: [false] });
  const result = await checkIp(makeAccount(), "region-a", {}, makeServer("ping-fail"), deps);

  assert.equal(result.status, "changed");
  assert.equal(calls.rotate, 1);
  assert.equal(calls.tcp, 0);
});

test("ping 通且 TCP 成功时不换 IP", async () => {
  const { deps, calls } = makeDeps({
    tcpResults: [{ port: 22, ok: true, reason: "connect" }],
  });
  const result = await checkIp(makeAccount(), "region-a", {}, makeServer("tcp-ok"), deps);

  assert.equal(result.status, "reachable");
  assert.equal(calls.rotate, 0);
});

test("TCP 全部被拒绝时不换 IP", async () => {
  const { deps, calls } = makeDeps({
    tcpResults: [{ port: 22, ok: false, reason: "refused" }],
  });
  const result = await checkIp(makeAccount(), "region-a", {}, makeServer("tcp-refused"), deps);

  assert.equal(result.status, "reachable");
  assert.equal(calls.rotate, 0);
});

test("观察模式（rotateOnTcpDown=false）连续可疑也不换 IP", async () => {
  const account = makeAccount({ rotateOnTcpDown: false });
  const { deps, calls } = makeDeps({
    tcpResults: [{ port: 22, ok: false, reason: "timeout" }],
  });
  const server = makeServer("observe-only");

  for (let round = 0; round < 3; round++) {
    const result = await checkIp(account, "region-a", {}, server, deps);
    assert.equal(result.status, "reachable");
  }

  assert.equal(calls.rotate, 0);
});

test("连续达到 confirmRounds 后触发换 IP", async () => {
  const { deps, calls } = makeDeps({
    tcpResults: [{ port: 22, ok: false, reason: "timeout" }],
  });
  const server = makeServer("streak-rotate");

  const first = await checkIp(makeAccount(), "region-a", {}, server, deps);
  assert.equal(first.status, "reachable");
  assert.equal(calls.rotate, 0);

  const second = await checkIp(makeAccount(), "region-a", {}, server, deps);
  assert.equal(second.status, "changed");
  assert.equal(calls.rotate, 1);
});

test("ping 失败换 IP 后，TCP 连续失败计数清零", async () => {
  const { deps, calls } = makeDeps({
    pingResults: [true, false, true],
    tcpResults: [{ port: 22, ok: false, reason: "timeout" }],
  });
  const server = makeServer("streak-reset");

  // 第 1 轮：ping 通 + TCP 超时 → streak = 1
  assert.equal(
    (await checkIp(makeAccount(), "region-a", {}, server, deps)).status,
    "reachable"
  );

  // 第 2 轮：ping 失败 → 换 IP，计数清零
  assert.equal(
    (await checkIp(makeAccount(), "region-a", {}, server, deps)).status,
    "changed"
  );

  // 第 3 轮：ping 通 + TCP 超时 → 应从 1 重新累计，不立即换 IP
  assert.equal(
    (await checkIp(makeAccount(), "region-a", {}, server, deps)).status,
    "reachable"
  );

  assert.equal(calls.rotate, 1);
});

test("换 IP 失败时返回 failed", async () => {
  const { deps } = makeDeps({
    pingResults: [false],
    rotateError: new Error("boom"),
  });
  const result = await checkIp(makeAccount(), "region-a", {}, makeServer("rotate-fail"), deps);

  assert.equal(result.status, "failed");
});

test("静态 IP 实例走静态 IP 轮换流程", async () => {
  const { deps, calls } = makeDeps({ pingResults: [false] });
  const result = await checkIp(makeAccount(), "region-a", {}, makeServer("static-ip", true), deps);

  assert.equal(result.status, "changed");
  assert.equal(calls.rotate, 1);
});

test("纯 ping 模式：ping 通时不探测 TCP", async () => {
  const account = { name: "main", check: { ...CHECK, mode: "ping", ports: [] } };
  const { deps, calls } = makeDeps();

  const result = await checkIp(account, "region-a", {}, makeServer("ping-mode-ok"), deps);

  assert.equal(result.status, "reachable");
  assert.equal(calls.tcp, 0);
  assert.equal(calls.rotate, 0);
});

test("纯 ping 模式：ping 不通时触发换 IP", async () => {
  const account = { name: "main", check: { ...CHECK, mode: "ping", ports: [] } };
  const { deps, calls } = makeDeps({ pingResults: [false] });

  const result = await checkIp(account, "region-a", {}, makeServer("ping-mode-fail"), deps);

  assert.equal(result.status, "changed");
  assert.equal(calls.tcp, 0);
  assert.equal(calls.rotate, 1);
});

test("账号没有 check 配置时按纯 ping 处理", async () => {
  const { deps, calls } = makeDeps();

  const result = await checkIp({ name: "main" }, "region-a", {}, makeServer("no-check"), deps);

  assert.equal(result.status, "reachable");
  assert.equal(calls.tcp, 0);
  assert.equal(calls.rotate, 0);
});
