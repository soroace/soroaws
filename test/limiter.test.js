const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter } = require("../src/limiter");

test("并发数不超过配置上限", async () => {
  const run = createLimiter(2);
  let active = 0;
  let peak = 0;

  const task = () =>
    run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });

  await Promise.all(Array.from({ length: 6 }, task));
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("任务结果与异常原样透传", async () => {
  const run = createLimiter(1);

  assert.equal(await run(async () => 42), 42);
  await assert.rejects(
    run(async () => {
      throw new Error("boom");
    }),
    /boom/
  );
});

test("前一个任务失败后队列继续执行", async () => {
  const run = createLimiter(1);
  const order = [];

  await Promise.allSettled([
    run(async () => {
      order.push("a");
      throw new Error("a failed");
    }),
    run(async () => {
      order.push("b");
      return "b";
    }),
  ]);

  assert.deepEqual(order, ["a", "b"]);
});
