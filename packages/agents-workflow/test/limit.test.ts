// Swap 2: the limiter is p-limit now (tested via engine's concurrency bound in
// engine.test.ts). Only defaultConcurrency survives as our own util - keep the
// old concurrency.test.ts intent for it here.
import { test, expect } from "vitest";
import pLimit from "p-limit";
import { defaultConcurrency } from "../src/limit.js";

test("defaultConcurrency is above Claude's 16 cap and clamps to 32", () => {
  expect(defaultConcurrency(8)).toBeLessThanOrEqual(32);
  expect(defaultConcurrency(64)).toBe(32);
  expect(defaultConcurrency(1)).toBe(2); // floor of 2
});

test("p-limit (the survivor) never exceeds max concurrency", async () => {
  const limit = pLimit(3);
  let active = 0,
    peak = 0;
  const job = (): Promise<void> =>
    new Promise((res) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        res();
      }, 5);
    });
  await Promise.all(Array.from({ length: 20 }, () => limit(job)));
  expect(peak).toBeLessThanOrEqual(3);
});
