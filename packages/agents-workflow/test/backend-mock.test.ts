// ported from flowkit test/backend-mock.test.ts (node:test -> vitest).
import { test, expect, vi } from "vitest";
import { MockBackend } from "../src/backends/mock.js";

test("MockBackend is an AgentBackend with a name", () => {
  const b = new MockBackend();
  expect(b.name).toBe("mock");
  expect(typeof b.run).toBe("function");
});

test("MockBackend returns responder output and records calls", async () => {
  const b = new MockBackend({ respond: (spec) => ({ text: "hi:" + spec.label }) });
  const r = await b.run({ prompt: "p", label: "L1" });
  expect(r.text).toBe("hi:L1");
  expect(b.calls.length).toBe(1);
  expect(b.calls[0].label).toBe("L1");
});

test("MockBackend scripted() branches on prompt/label", async () => {
  const b = new MockBackend({
    respond: MockBackend.scripted({
      scope: { text: '{"diffBase":"main"}' },
      verify: { text: '{"refuted":false}' },
    }),
  });
  expect((await b.run({ prompt: "do scope now" })).text).toBe('{"diffBase":"main"}');
  expect((await b.run({ prompt: "please verify" })).text).toBe('{"refuted":false}');
});

test("MockBackend scripted() fallback + function replies", async () => {
  const b = new MockBackend({
    respond: MockBackend.scripted(
      { hit: (s) => ({ text: "fn:" + s.label }) },
      { fallback: (s) => ({ text: "fb:" + s.label }) },
    ),
  });
  expect((await b.run({ prompt: "hit it", label: "A" })).text).toBe("fn:A");
  expect((await b.run({ prompt: "miss", label: "B" })).text).toBe("fb:B");
});

test("MockBackend auto() synthesizes JSON from an embedded schema", async () => {
  const b = new MockBackend({ respond: MockBackend.auto() });
  const prompt =
    'JSON Schema:\n{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}';
  const r = await b.run({ prompt });
  expect(JSON.parse(r.text!)).toEqual({ ok: false });
  // no schema block -> stub string
  const r2 = await b.run({ prompt: "plain task" });
  expect(r2.text).toBe("stub");
});

test("MockBackend latency is virtual-time friendly", async () => {
  vi.useFakeTimers();
  const b = new MockBackend({ latencyMs: 1000, respond: () => ({ text: "x" }) });
  const p = b.run({ prompt: "p" });
  await vi.advanceTimersByTimeAsync(1000);
  const r = await p;
  expect(r.text).toBe("x");
  vi.useRealTimers();
});

test("MockBackend can simulate failures (engine maps to null)", async () => {
  const b = new MockBackend({ respond: () => ({ error: "boom" }) });
  const r = await b.run({ prompt: "p" });
  expect(r.error).toBe("boom");
});

test("MockBackend async responder + string reply are normalized", async () => {
  const b = new MockBackend({ respond: async () => "just a string" });
  const r = await b.run({ prompt: "p" });
  expect(r.text).toBe("just a string");
});

test("MockBackend dispose() is a no-op lifecycle hook", async () => {
  await expect(new MockBackend().dispose()).resolves.toBeUndefined();
});
