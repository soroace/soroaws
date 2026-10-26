const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { tcpProbe, probeTcpPorts } = require("../src/checker");

function startServer(onConnection) {
  const server = net.createServer(onConnection || ((socket) => socket.destroy()));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("端口监听时 tcpProbe 返回 connect", async () => {
  const { server, port } = await startServer();

  try {
    const result = await tcpProbe("127.0.0.1", port, 1000);
    assert.deepEqual(result, { ok: true, reason: "connect" });
  } finally {
    await stopServer(server);
  }
});

test("端口关闭时 tcpProbe 返回 refused", async () => {
  const { server, port } = await startServer();
  await stopServer(server);

  const result = await tcpProbe("127.0.0.1", port, 1000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "refused");
});

test("不可路由地址会失败并返回（不会挂起）", async () => {
  const result = await tcpProbe("192.0.2.1", 22, 300);
  assert.equal(result.ok, false);
  assert.ok(["timeout", "unreachable", "error"].includes(result.reason));
});

test("probeTcpPorts 任一端口成功即提前结束", async () => {
  const calls = [];
  const probe = async (host, port) => {
    calls.push(port);
    return port === 22
      ? { ok: true, reason: "connect" }
      : { ok: false, reason: "timeout" };
  };

  const results = await probeTcpPorts("1.2.3.4", [22, 443], 1000, probe);

  assert.deepEqual(calls, [22]);
  assert.deepEqual(results, [{ port: 22, ok: true, reason: "connect" }]);
});

test("probeTcpPorts 全部失败时返回每个端口的结果", async () => {
  const probe = async (host, port) => ({ ok: false, reason: "timeout" });

  const results = await probeTcpPorts("1.2.3.4", [22, 443], 1000, probe);

  assert.deepEqual(results, [
    { port: 22, ok: false, reason: "timeout" },
    { port: 443, ok: false, reason: "timeout" },
  ]);
});
