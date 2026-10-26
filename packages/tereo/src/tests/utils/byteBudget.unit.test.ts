// @module-tag unit
// @module-tag files
import { ServiceUnavailableError } from "../../utils/errors.js";
import { ByteBudget } from "../../utils/byteBudget.js";
import { describe, expect, it } from "vitest";

const settled = async <T>(promise: Promise<T>) => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  await new Promise((r) => setImmediate(r));
  return done;
};

describe("ByteBudget", () => {
  it("grants what fits at once and queues the rest until it is released", async () => {
    const budget = new ByteBudget(100, 1000);
    const releaseA = await budget.acquire(60);
    const b = budget.acquire(60);
    expect(await settled(b)).toBe(false);
    expect(budget.waiting).toBe(1);

    releaseA();
    const releaseB = await b;
    expect(budget.used).toBe(60);
    releaseB();
    releaseB();
    expect(budget.used).toBe(0);
  });

  it("serves waiters in order, so a small request does not pass a large one", async () => {
    const budget = new ByteBudget(100, 1000);
    const release = await budget.acquire(50);
    const large = budget.acquire(80);
    const small = budget.acquire(10);
    expect(await settled(small)).toBe(false);

    release();
    (await large)();
    (await small)();
    expect(budget.used).toBe(0);
  });

  it("lets a request larger than the pool run alone", async () => {
    const budget = new ByteBudget(100, 1000);
    const release = await budget.acquire(500);
    expect(budget.used).toBe(100);
    release();
  });

  it("rejects with a 503 after waiting too long, and lets the next one in", async () => {
    const budget = new ByteBudget(100, 20);
    const release = await budget.acquire(100);
    await expect(budget.acquire(1)).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
    expect(budget.waiting).toBe(0);
    release();
    (await budget.acquire(100))();
  });
});
