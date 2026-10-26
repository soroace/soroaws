const test = require("node:test");
const assert = require("node:assert/strict");
const { VERDICT, classify, nextFailureStreak } = require("../src/detector");

test("ping 不通时判定 unreachable", () => {
  assert.equal(classify({ pingReachable: false }), VERDICT.UNREACHABLE);
  assert.equal(
    classify({ pingReachable: false, tcpResults: [{ ok: true, reason: "connect" }] }),
    VERDICT.UNREACHABLE
  );
});

test("未启用 TCP 探测时判定 ok", () => {
  assert.equal(classify({ pingReachable: true, tcpResults: [] }), VERDICT.OK);
  assert.equal(classify({ pingReachable: true }), VERDICT.OK);
});

test("任一端口成功时判定 ok", () => {
  assert.equal(
    classify({
      pingReachable: true,
      tcpResults: [
        { ok: false, reason: "timeout" },
        { ok: true, reason: "connect" },
      ],
    }),
    VERDICT.OK
  );
});

test("端口全部被拒绝时判定 refused", () => {
  assert.equal(
    classify({
      pingReachable: true,
      tcpResults: [
        { ok: false, reason: "refused" },
        { ok: false, reason: "refused" },
      ],
    }),
    VERDICT.REFUSED
  );
});

test("端口全部超时时判定 suspicious", () => {
  assert.equal(
    classify({ pingReachable: true, tcpResults: [{ ok: false, reason: "timeout" }] }),
    VERDICT.SUSPICIOUS
  );
});

test("拒绝与超时混合且无成功时判定 suspicious", () => {
  assert.equal(
    classify({
      pingReachable: true,
      tcpResults: [
        { ok: false, reason: "refused" },
        { ok: false, reason: "timeout" },
      ],
    }),
    VERDICT.SUSPICIOUS
  );
});

test("关闭换 IP 时 suspicious 只累计不触发", () => {
  const result = nextFailureStreak(0, VERDICT.SUSPICIOUS, {
    confirmRounds: 2,
    rotateOnTcpDown: false,
  });

  assert.deepEqual(result, { streak: 1, shouldRotate: false });
});

test("连续达到阈值且开启换 IP 时触发", () => {
  let streak = 0;
  let result = { streak: 0, shouldRotate: false };

  for (let round = 0; round < 2; round++) {
    result = nextFailureStreak(streak, VERDICT.SUSPICIOUS, {
      confirmRounds: 2,
      rotateOnTcpDown: true,
    });
    streak = result.streak;
  }

  assert.equal(result.streak, 2);
  assert.equal(result.shouldRotate, true);
});

test("未达到阈值时不触发", () => {
  const result = nextFailureStreak(0, VERDICT.SUSPICIOUS, {
    confirmRounds: 3,
    rotateOnTcpDown: true,
  });

  assert.deepEqual(result, { streak: 1, shouldRotate: false });
});

test("ok / refused / unreachable 都会清零累计轮次", () => {
  for (const verdict of [VERDICT.OK, VERDICT.REFUSED, VERDICT.UNREACHABLE]) {
    assert.deepEqual(nextFailureStreak(3, verdict), {
      streak: 0,
      shouldRotate: false,
    });
  }
});
