const test = require("node:test");
const assert = require("node:assert/strict");
const { rotateStaticIp, allocateAndAttach } = require("../src/rotate");

function makeServer(overrides = {}) {
  return {
    name: "vps-1",
    publicIpAddress: "1.2.3.4",
    isStaticIp: false,
    state: { name: "running" },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const calls = [];

  const deps = {
    log: () => {},
    fetchStaticIps: async () => [],
    detachStaticIp: async (client, name) => calls.push({ op: "detach", name }),
    releaseStaticIp: async (client, name) => calls.push({ op: "release", name }),
    allocateStaticIp: async (client, name) => calls.push({ op: "allocate", name }),
    attachStaticIp: async (client, instanceName, name) =>
      calls.push({ op: "attach", instanceName, name }),
    fetchInstances: async () => [{ name: "vps-1", publicIpAddress: "5.6.7.8" }],
    notifyIpChange: async (details) => calls.push({ op: "notify", details }),
    ...overrides,
  };

  return { deps, calls };
}

test("有静态 IP：解绑 → 释放 → 分配 → 绑定 → 成功通知", async () => {
  const { deps, calls } = makeDeps({
    fetchStaticIps: async () => [
      { name: "old-ip", ipAddress: "1.2.3.4", isAttached: true },
    ],
  });

  await rotateStaticIp(
    "main",
    "ap-northeast-1",
    {},
    makeServer({ isStaticIp: true }),
    deps
  );

  assert.deepEqual(
    calls.map((call) => call.op),
    ["detach", "release", "allocate", "attach", "notify"]
  );
  assert.equal(calls[0].name, "old-ip");
  assert.equal(calls[1].name, "old-ip");
  assert.match(calls[2].name, /^vps-1-\d+$/);
  assert.equal(calls[3].name, calls[2].name);
  assert.equal(calls[4].details.oldIp, "1.2.3.4");
  assert.equal(calls[4].details.newIp, "5.6.7.8");
  assert.equal(calls[4].details.account, "main");
  assert.equal(calls[4].details.region, "ap-northeast-1");
});

test("未找到对应静态 IP 时直接分配并绑定", async () => {
  const { deps, calls } = makeDeps({ fetchStaticIps: async () => [] });

  await rotateStaticIp(
    "main",
    "ap-northeast-1",
    {},
    makeServer({ isStaticIp: true }),
    deps
  );

  assert.deepEqual(
    calls.map((call) => call.op),
    ["allocate", "attach", "notify"]
  );
});

test("绑定失败时回滚释放新 IP、发失败通知并抛错", async () => {
  const { deps, calls } = makeDeps({
    fetchStaticIps: async () => [],
    attachStaticIp: async (client, instanceName, name) => {
      calls.push({ op: "attach", instanceName, name });
      throw new Error("attach boom");
    },
  });

  await assert.rejects(
    rotateStaticIp(
      "main",
      "ap-northeast-1",
      {},
      makeServer({ isStaticIp: true }),
      deps
    ),
    /attach boom/
  );

  assert.deepEqual(
    calls.map((call) => call.op),
    ["allocate", "attach", "release", "notify"]
  );
  assert.equal(calls[2].name, calls[0].name);
  assert.equal(calls[3].details.success, false);
  assert.equal(calls[3].details.reason, "attach boom");
  assert.equal(calls[3].details.newIp, "-");
});

test("创建静态 IP 失败时发失败通知并抛错，不继续绑定", async () => {
  const { deps, calls } = makeDeps({
    allocateStaticIp: async (client, name) => {
      calls.push({ op: "allocate", name });
      throw new Error("allocate boom");
    },
  });

  await assert.rejects(
    allocateAndAttach("main", "ap-northeast-1", {}, makeServer(), deps),
    /allocate boom/
  );

  assert.deepEqual(
    calls.map((call) => call.op),
    ["allocate", "notify"]
  );
  assert.equal(calls[1].details.success, false);
  assert.equal(calls[1].details.reason, "allocate boom");
});

test("绑定成功但查询新 IP 失败时，通知里用 - 兜底", async () => {
  const { deps, calls } = makeDeps({
    fetchInstances: async () => {
      throw new Error("fetch boom");
    },
  });

  await allocateAndAttach("main", "ap-northeast-1", {}, makeServer(), deps);

  const notify = calls.find((call) => call.op === "notify");
  assert.equal(notify.details.newIp, "-");
  assert.equal(notify.details.success, undefined);
});

test("无静态 IP 的实例直接分配并绑定", async () => {
  const { deps, calls } = makeDeps();

  await allocateAndAttach(
    "main",
    "ap-northeast-1",
    {},
    makeServer({ isStaticIp: false }),
    deps
  );

  assert.deepEqual(
    calls.map((call) => call.op),
    ["allocate", "attach", "notify"]
  );
  assert.equal(calls[2].details.newIp, "5.6.7.8");
});
