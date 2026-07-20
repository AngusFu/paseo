// onAgentEvent lifecycle events — the observability seam for live per-agent UI.
// queued -> start -> (retry*) -> complete | error ; cache hits emit
// start+complete with cached:true (they never run the backend).
import { expect, test } from "vitest";
import { createEngine, type AgentEvent } from "../src/engine.js";
import { MockBackend } from "../src/backends/mock.js";
import { Journal } from "../src/journal.js";

function recorder() {
  const evs: AgentEvent[] = [];
  return {
    evs,
    onAgentEvent: (e: AgentEvent) => {
      evs.push({ ...e });
    },
  };
}
const types = (evs: AgentEvent[]): string[] => evs.map((e) => e.type);

test("happy path: queued -> start -> complete, one monotonic id, phase carried", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "ok", usage: { outputTokens: 7 } }) });
  const src =
    "export const meta = { name: 't' }\nphase('P')\nconst r = await agent('x', { label: 'lbl-x', model: 'opus-x' })\nreturn r";
  const { result } = await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  expect(result).toBe("ok");
  expect(types(evs)).toEqual(["queued", "start", "complete"]);
  expect(evs.every((e) => e.id === 1)).toBe(true);
  expect(evs[0].phase).toBe("P");
  expect(evs[0].label).toBe("lbl-x");
  expect(evs[0].model).toBe("opus-x"); // model OVERRIDE carried on every event
  expect(evs[2].usage?.outputTokens).toBe(7);
});

test("parallel: each leaf gets a DISTINCT id + a full lifecycle", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "y" }) });
  const src =
    "export const meta = { name: 't' }\nawait parallel([() => agent('a'), () => agent('b'), () => agent('c')])\nreturn 1";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  const ids = [...new Set(evs.map((e) => e.id))];
  expect(ids.length).toBe(3);
  for (const id of ids)
    expect(types(evs.filter((e) => e.id === id))).toEqual(["queued", "start", "complete"]);
});

test("backend error -> terminal is 'error' (not complete), carries the message", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ error: "boom" }) });
  const src = "export const meta = { name: 't' }\nconst r = await agent('x')\nreturn r";
  const { result } = await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  expect(result).toBeNull();
  expect(types(evs)).toEqual(["queued", "start", "error"]);
  expect(evs.find((e) => e.type === "error")?.error).toBe("boom");
});

test("resume cache hit: start+complete with cached:true, NO queued (never runs backend)", async () => {
  const j = new Journal();
  const b = new MockBackend({ respond: () => ({ text: "z" }) });
  const src = "export const meta = { name: 't' }\nconst r = await agent('same')\nreturn r";
  await createEngine({ backend: b, journal: j }).run(src, { args: {} }); // populate
  const { evs, onAgentEvent } = recorder();
  await createEngine({ backend: b, journal: j, onAgentEvent }).run(src, { args: {} }); // replay
  expect(types(evs)).toEqual(["start", "complete"]);
  expect(evs.every((e) => e.cached === true)).toBe(true);
});

test("structured retry: a 'retry' event lands between start and complete", async () => {
  const { evs, onAgentEvent } = recorder();
  let n = 0;
  const b = new MockBackend({
    respond: () => (++n === 1 ? { text: "not json" } : { text: '{"ok":true}' }),
  });
  const src =
    "export const meta = { name: 't' }\nconst r = await agent('x', { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })\nreturn r";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  expect(types(evs)).toEqual(["queued", "start", "retry", "complete"]);
  expect(evs.find((e) => e.type === "retry")?.attempt).toBe(1);
});

test("no onAgentEvent config -> engine runs fine (events are opt-in)", async () => {
  const b = new MockBackend({ respond: () => ({ text: "ok" }) });
  const src = "export const meta = { name: 't' }\nreturn await agent('x')";
  const { result } = await createEngine({ backend: b }).run(src, { args: {} });
  expect(result).toBe("ok");
});

test("model is undefined when opts.model unset (inherits session/backend default)", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "ok" }) });
  const src = "export const meta = { name: 't' }\nreturn await agent('x')";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  expect(evs.length).toBe(3);
  expect(evs.every((e) => e.model === undefined)).toBe(true);
});

test("cache hit carries label + model too (not just cached)", async () => {
  const j = new Journal();
  const b = new MockBackend({ respond: () => ({ text: "z" }) });
  const src =
    "export const meta = { name: 't' }\nreturn await agent('same', { label: 'L', model: 'M' })";
  await createEngine({ backend: b, journal: j }).run(src, { args: {} }); // populate
  const { evs, onAgentEvent } = recorder();
  await createEngine({ backend: b, journal: j, onAgentEvent }).run(src, { args: {} }); // replay
  expect(types(evs)).toEqual(["start", "complete"]);
  expect(evs.every((e) => e.cached === true && e.label === "L" && e.model === "M")).toBe(true);
});

test("pipeline: every stage-call is its own agent id with a full lifecycle", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "y" }) });
  const src =
    "export const meta = { name: 't' }\nawait pipeline([1, 2], () => agent('s1'), () => agent('s2'))\nreturn 1";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  const ids = [...new Set(evs.map((e) => e.id))];
  expect(ids.length).toBe(4); // 2 items x 2 stages
  for (const id of ids)
    expect(types(evs.filter((e) => e.id === id))).toEqual(["queued", "start", "complete"]);
});

test("structured retries EXHAUSTED -> retry(1), retry(2), then error (not complete)", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "never json" }) }); // fails every attempt
  const src =
    "export const meta = { name: 't' }\nreturn await agent('x', { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })";
  const { result } = await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  expect(result).toBeNull();
  expect(types(evs)).toEqual(["queued", "start", "retry", "retry", "error"]);
  expect(evs.filter((e) => e.type === "retry").map((e) => e.attempt)).toEqual([1, 2]);
});

test("event ordering per id: queued strictly before start before terminal", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "ok" }) });
  const src =
    "export const meta = { name: 't' }\nawait parallel([() => agent('a'), () => agent('b')])\nreturn 1";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  for (const id of new Set(evs.map((e) => e.id))) {
    const seq = evs.map((e, i) => ({ ...e, i })).filter((e) => e.id === id);
    const at = (t: string): number => seq.find((e) => e.type === t)!.i;
    expect(at("queued")).toBeLessThan(at("start"));
    expect(at("start")).toBeLessThan(at("complete"));
  }
});

test("provider/effort/mode overrides ride along on every event", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "ok" }) });
  const src =
    "export const meta = { name: 't' }\n" +
    "const r = await agent('x', { provider: 'codex', effort: 'high', mode: 'plan' })\nreturn r";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  expect(types(evs)).toEqual(["queued", "start", "complete"]);
  for (const ev of evs) {
    expect(ev.provider).toBe("codex");
    expect(ev.effort).toBe("high");
    expect(ev.mode).toBe("plan");
  }
});

test("selection fields stay undefined when the call inherits run defaults", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({ respond: () => ({ text: "ok" }) });
  const src = "export const meta = { name: 't' }\nreturn await agent('x')";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  for (const ev of evs) {
    expect(ev.provider).toBeUndefined();
    expect(ev.effort).toBeUndefined();
    expect(ev.mode).toBeUndefined();
  }
});

test("a cache hit still carries the selection fields", async () => {
  const journal = new Journal();
  const src =
    "export const meta = { name: 't' }\n" +
    "return await agent('x', { provider: 'codex', effort: 'low', mode: 'ask' })";
  const b = new MockBackend({ respond: () => ({ text: "ok" }) });
  await createEngine({ backend: b, journal }).run(src, { args: {} });

  const { evs, onAgentEvent } = recorder();
  await createEngine({ backend: b, journal, onAgentEvent }).run(src, { args: {} });
  expect(types(evs)).toEqual(["start", "complete"]);
  expect(evs.every((e) => e.cached === true)).toBe(true);
  expect(evs.every((e) => e.provider === "codex" && e.effort === "low" && e.mode === "ask")).toBe(
    true,
  );
});

test("the complete event forwards the backend's whole usage record", async () => {
  const { evs, onAgentEvent } = recorder();
  const b = new MockBackend({
    respond: () => ({
      text: "ok",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 7,
        totalCostUsd: 0.5,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 1_234,
      },
    }),
  });
  const src = "export const meta = { name: 't' }\nreturn await agent('x')";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  expect(evs[2].usage).toEqual({
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 7,
    totalCostUsd: 0.5,
    contextWindowMaxTokens: 200_000,
    contextWindowUsedTokens: 1_234,
  });
});

test("the engine hands the backend a callId matching the event id", async () => {
  const seen: Array<number | undefined> = [];
  const b = new MockBackend({
    respond: (spec) => {
      seen.push(spec.callId);
      return { text: "ok" };
    },
  });
  const { evs, onAgentEvent } = recorder();
  const src =
    "export const meta = { name: 't' }\nawait parallel([() => agent('a'), () => agent('b')])\nreturn 1";
  await createEngine({ backend: b, onAgentEvent }).run(src, { args: {} });
  const eventIds = [...new Set(evs.map((e) => e.id))].sort();
  expect(seen.filter((id) => id != null).sort()).toEqual(eventIds);
});
