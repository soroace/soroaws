const test = require("node:test");
const assert = require("node:assert/strict");
const { createClients } = require("../src/lightsail");

test("按「账号 × 区域」展开客户端", () => {
  const clients = createClients([
    {
      name: "main",
      credentials: { accessKeyId: "A1", secretAccessKey: "S1" },
      regions: ["ap-northeast-1", "ap-southeast-1"],
    },
    {
      name: "backup",
      credentials: { accessKeyId: "A2", secretAccessKey: "S2" },
      regions: ["us-east-1"],
    },
  ]);

  assert.equal(clients.length, 3);
  assert.deepEqual(
    clients.map((item) => `${item.account}/${item.region}`),
    ["main/ap-northeast-1", "main/ap-southeast-1", "backup/us-east-1"]
  );
  assert.equal(clients[0].client.constructor.name, "LightsailClient");
});

test("账号区域为空时不产生客户端", () => {
  const clients = createClients([
    {
      name: "empty",
      credentials: { accessKeyId: "A", secretAccessKey: "S" },
      regions: [],
    },
  ]);

  assert.deepEqual(clients, []);
});

test("禁用账号不产生客户端", () => {
  const clients = createClients([
    {
      name: "on",
      enabled: true,
      credentials: { accessKeyId: "A1", secretAccessKey: "S1" },
      regions: ["us-east-1"],
    },
    {
      name: "off",
      enabled: false,
      credentials: { accessKeyId: "A2", secretAccessKey: "S2" },
      regions: ["us-east-1"],
    },
  ]);

  assert.deepEqual(
    clients.map((item) => item.account),
    ["on"]
  );
});
