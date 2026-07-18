// ported from flowkit test/engine.test.ts (node:test -> vitest) + extra cases
// for the two swaps (zod schema branch) and coverage of guard paths.
import { test, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEngine, extractMeta } from "../src/engine.js";
import { MockBackend } from "../src/backends/mock.js";
import { Journal } from "../src/journal.js";
import { z } from "zod";
import { WorkflowError } from "../src/index.js";
import * as prompts from "../src/prompt-library.js";

const wrap = (body: string): string =>
  `export const meta = { name: "t", description: "d", phases: [] };\n${body}`;

test("extractMeta splits meta and body", () => {
  const { meta, body } = extractMeta(wrap("return 1 + 1;"));
  expect(meta.name).toBe("t");
  expect(body.includes("export const meta")).toBe(false);
});

test("extractMeta tolerates braces inside meta strings", () => {
  const src = `export const meta = { name: "t", description: "has } brace" };\nreturn 1;`;
  const { meta } = extractMeta(src);
  expect(meta.description).toBe("has } brace");
});

test("extractMeta throws on missing/invalid meta", () => {
  expect(() => extractMeta("return 1;")).toThrow(/begin with/);
  expect(() => extractMeta("export const meta = 5;")).toThrow(/object literal/);
  expect(() => extractMeta("export const meta = { bad: nope };\n")).toThrow(/evaluate meta/);
});

// ── Finding 1 (CRITICAL) — extractMeta used to host-eval the meta literal with
// `new Function`, so a malicious meta ran host code on mere LISTING. Now it
// evals in a LOCKED, EMPTY vm realm: require/process are undefined + codegen
// off, so the payload THROWS and leaves NO host effect.
let sentinel: string | null = null;
afterEach(() => {
  if (sentinel && fs.existsSync(sentinel)) fs.rmSync(sentinel);
  sentinel = null;
});

test("Finding 1: malicious meta cannot execute host code (no sentinel written)", () => {
  sentinel = path.join(os.tmpdir(), `flow2-meta-rce-${process.pid}-${Date.now()}.txt`);
  const evil =
    `export const meta = { name: (function(){ require('child_process'); ` +
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'pwned'); return 't'; })() };\n` +
    `return 1;`;
  // the eval THROWS (require is undefined in the empty realm) ...
  expect(() => extractMeta(evil)).toThrow(/evaluate meta/);
  // ... and the payload's host side-effect never happened.
  expect(fs.existsSync(sentinel)).toBe(false);
});

test("Finding 1: meta reading process.env throws, never reads host env", () => {
  const evil = `export const meta = { name: (function(){ return process.env.HOME || 't'; })() };\nreturn 1;`;
  expect(() => extractMeta(evil)).toThrow(/evaluate meta/);
});

test("Finding 1: a normal pure-literal meta still parses correctly", () => {
  const { meta } = extractMeta(
    `export const meta = { name: "ok", description: "d", n: 1 + 2 };\nreturn 1;`,
  );
  expect(meta.name).toBe("ok");
  expect(meta.n).toBe(3);
});

test("createEngine rejects a non-backend", () => {
  expect(() => createEngine({ backend: {} as never })).toThrow(/AgentBackend/);
});

test("agent() rejects a non-string prompt", async () => {
  const e = createEngine({ backend: new MockBackend() });
  await expect(e.run(wrap(`return await agent(42);`))).rejects.toThrow(/string prompt/);
});

test("agent() returns text and prepends the subagent persona", async () => {
  const b = new MockBackend({ respond: () => ({ text: "RESULT" }) });
  const e = createEngine({ backend: b });
  const { result } = await e.run(wrap(`return await agent("do the thing");`));
  expect(result).toBe("RESULT");
  expect(b.calls[0].prompt).toContain("subagent spawned by a workflow");
  expect(b.calls[0].prompt).toContain("do the thing");
});

test("agent() with agentType appends the agentType note", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b });
  await e.run(wrap(`return await agent("t", { agentType: "reviewer" });`));
  expect(b.calls[0].prompt).toContain("running inside a workflow script");
});

test("agent() with a JSON-Schema object validates and returns parsed object", async () => {
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const b = new MockBackend({ respond: () => ({ text: '{"ok":true}' }) });
  const e = createEngine({ backend: b });
  const { result } = await e.run(
    wrap(`return await agent("x", { schema: ${JSON.stringify(schema)} });`),
  );
  expect(result).toEqual({ ok: true });
});

test("agent() accepts a zod schema (flow2 native form)", async () => {
  const b = new MockBackend({ respond: () => ({ text: '{"n":7}' }) });
  const e = createEngine({ backend: b });
  // zod schema can't be JSON-embedded in the script; run() via load + injected agent.
  const wf = e.load(wrap(`return await agent("x", { schema: args.schema });`));
  const result = await wf.run({ schema: z.object({ n: z.number() }) });
  expect(result).toEqual({ n: 7 });
});

test("structured loop retries on bad JSON then succeeds", async () => {
  const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
  let i = 0;
  const replies = ["not json", '{"n":"wrong type"}', '{"n":7}'];
  const b = new MockBackend({ respond: () => ({ text: replies[i++] }) });
  const e = createEngine({ backend: b });
  const { result, stats } = await e.run(
    wrap(`return await agent("x", { schema: ${JSON.stringify(schema)} });`),
  );
  expect(result).toEqual({ n: 7 });
  expect(b.calls.length).toBe(3);
  expect(stats.structuredRetries).toBe(2);
});

test("structured loop returns null after exhausting retries", async () => {
  const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
  const b = new MockBackend({ respond: () => ({ text: "garbage" }) });
  const e = createEngine({ backend: b });
  const { result } = await e.run(
    wrap(`return await agent("x", { schema: ${JSON.stringify(schema)}, maxRetries: 1 });`),
  );
  expect(result).toBe(null);
});

// ── review 2026-07-18 #1 — an unbounded opts.maxRetries multiplied REAL
// backend calls without touching the agent cap. Now clamped to a hard cap (10).
test("review #1: a huge maxRetries is clamped — backend calls stay bounded", async () => {
  const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
  const b = new MockBackend({ respond: () => ({ text: "garbage" }) });
  const e = createEngine({ backend: b });
  const { result } = await e.run(
    wrap(`return await agent("x", { schema: ${JSON.stringify(schema)}, maxRetries: 999999 });`),
  );
  expect(result).toBe(null);
  expect(b.calls.length).toBeLessThanOrEqual(11); // MAX_RETRIES_CAP(10) + first attempt
});

test("review #1: a non-integer maxRetries falls back to the default (2)", async () => {
  const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
  const b = new MockBackend({ respond: () => ({ text: "garbage" }) });
  const e = createEngine({ backend: b });
  await e.run(
    wrap(`return await agent("x", { schema: ${JSON.stringify(schema)}, maxRetries: 1.5 });`),
  );
  expect(b.calls.length).toBe(3); // default 2 retries + first attempt
});

// ── review 2026-07-18 #2 — success was detected via `value === null`, so a
// schema whose VALID value is null misread success as failure.
test("review #2: a { type: 'null' } schema success is a complete, not an error", async () => {
  const events: string[] = [];
  const b = new MockBackend({ respond: () => ({ text: "null" }) });
  const e = createEngine({ backend: b, onAgentEvent: (ev) => events.push(ev.type) });
  const { result } = await e.run(wrap(`return await agent("x", { schema: { type: "null" } });`));
  expect(result).toBe(null);
  expect(b.calls.length).toBe(1); // no retry loop — first reply validated
  expect(events).toContain("complete");
  expect(events).not.toContain("error");
});

test("agent cap (k0y) throws after limit", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b, agentCap: 2 });
  await expect(e.run(wrap(`for (let i=0;i<5;i++) await agent("a"+i);`))).rejects.toThrowError(
    prompts.WorkflowAgentCapError,
  );
});

test("budget exceeded (wAd) throws when token budget is hit", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x".repeat(100) }), tokensPerChar: 1 });
  const e = createEngine({ backend: b, budgetTokens: 150 });
  await expect(
    e.run(wrap(`await agent("1"); await agent("2"); await agent("3");`)),
  ).rejects.toThrowError(prompts.WorkflowBudgetExceededError);
});

test("budget est kicks in when backend reports no usage", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) }); // no usage
  const e = createEngine({ backend: b, budgetTokens: 1000 });
  const { budget } = await e.run(wrap(`await agent("a"); await agent("b");`));
  expect(budget.spent).toBe(1024); // 2 * DEFAULT_EST_TOKENS(512)
});

// ── Finding 4 (MED) — the engine used to add DEFAULT_EST_TOKENS on TOP of real
// usage on every call, overcharging by 512 (a usage=100 call cost 612). Now the
// estimate is charged ONLY for a call the backend gave no usage for.
test("Finding 4: real usage is charged exactly (100, not 612)", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x", usage: { outputTokens: 100 } }) });
  const e = createEngine({ backend: b, budgetTokens: 100000 });
  const { budget } = await e.run(wrap(`await agent("a");`));
  expect(budget.spent).toBe(100);
});
test("Finding 4: a no-usage call is charged the flat estimate (512)", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) }); // no usage
  const e = createEngine({ backend: b, budgetTokens: 100000 });
  const { budget } = await e.run(wrap(`await agent("a");`));
  expect(budget.spent).toBe(512);
});

// ── Finding 5 (MED) — the old pre-check `_spent >= total` read a STALE _spent;
// N concurrent agent()s under parallel() all passed it, then all spent ->
// massive overshoot. The fix reserves an estimate SYNCHRONOUSLY before awaiting
// the backend, so only ~ceil(total/est) leaves get launched, not all N.
test("Finding 5: check-and-reserve bounds parallel() launches under a small budget", async () => {
  const N = 50,
    EST = 512,
    total = 1024,
    concurrency = 4;
  const b = new MockBackend({ latencyMs: 1, respond: () => ({ text: "x" }) }); // no usage -> est each
  const e = createEngine({ backend: b, budgetTokens: total, maxConcurrency: concurrency });
  // NOTE (Fix A): parallel() NEVER rejects — a thunk whose agent() throws
  // WorkflowBudgetExceededError now resolves to null in that slot. So the run
  // RESOLVES with a mostly-null array; the reserve-bounding is proven by the
  // backend call count, NOT by a propagated throw.
  const { result } = await e.run(
    wrap(`return await parallel(Array.from({length: ${N}}, (_,i) => () => agent("x"+i)));`),
  );
  expect((result as unknown[]).length).toBe(N); // one slot per thunk
  // reservation is synchronous+sequential -> only the budgeted few reach the
  // backend BEFORE agent() starts throwing. NOT all N (the old race launched all).
  expect(b.calls.length).toBeLessThanOrEqual(Math.ceil(total / EST) + concurrency);
  expect(b.calls.length).toBeLessThan(N);
});

test("budget.remaining() is Infinity with no budget; loop still bounded by cap", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b });
  const { result } = await e.run(
    wrap(`
    let n = 0;
    while (budget.remaining() > 0 && n < 3) { await agent("x"+n); n++; }
    return n;
  `),
  );
  expect(result).toBe(3);
});

test("parallel() runs fns and preserves order", async () => {
  const b = new MockBackend({ respond: (s) => ({ text: s.label }) });
  const e = createEngine({ backend: b });
  const { result } = await e.run(
    wrap(`
    return await parallel([0,1,2].map(i => () => agent("task", { label: "L"+i })));
  `),
  );
  expect(result).toEqual(["L0", "L1", "L2"]);
});

// ── Fix A (HIGH) — pipeline() has NO barrier: each item flows through ALL
// stages INDEPENDENTLY. The OLD test enshrined a barrier ("all stage-A before
// any stage-B"); that is the WRONG contract. Here item 1 (fast) finishes BOTH
// stages before item 2 (slow) even finishes stage A — impossible under a
// barrier. Also proves the stage signature (prevResult, originalItem, index).
test("pipeline() runs items independently with NO barrier between stages", async () => {
  const order: string[] = [];
  const b = new MockBackend({
    respond: async (s) => {
      await new Promise<void>((r) => setTimeout(r, s.label!.includes("slow") ? 30 : 1));
      order.push(s.label!);
      return { text: s.label };
    },
  });
  const e = createEngine({ backend: b, maxConcurrency: 10 });
  const { result } = await e.run(
    wrap(`
    return await pipeline([1,2],
      (it) => agent("stageA", { label: (it===2?"slow-":"fast-")+"A"+it }),
      (prev, it, i) => agent("stageB", { label: "B"+it+"-"+i }));
  `),
  );
  // no barrier: item 1's stage-B completes BEFORE item 2's (slow) stage-A does.
  expect(order.indexOf("B1-0")).toBeLessThan(order.indexOf("slow-A2"));
  // stage callback got originalItem (1/2) + index (0/1), not just prevResult.
  expect(result).toEqual(["B1-0", "B2-1"]);
});

// ── Fix C (HIGH) — budget/agent-cap state is per-ENGINE and used to LEAK
// across run()s. Each run() must start fresh (journal stays for resume).
test("Fix C: budget._spent resets between run()s", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) }); // no usage -> 512 est
  const e = createEngine({ backend: b, budgetTokens: 1000 });
  const r1 = await e.run(wrap(`await agent("a");`));
  const r2 = await e.run(wrap(`await agent("b");`));
  expect(r1.budget.spent).toBe(512);
  expect(r2.budget.spent).toBe(512); // fresh, NOT 1024
});
test("Fix C: agent-cap counter resets between run()s", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b, agentCap: 2 });
  await e.run(wrap(`await agent("a"); await agent("b");`)); // 2 calls -> at the cap
  // second run of 2 calls must NOT throw — the cap count started over.
  await expect(e.run(wrap(`await agent("a"); await agent("b");`))).resolves.toBeDefined();
});

test("parallel() batch cap (4096) throws a clear error", async () => {
  const e = createEngine({ backend: new MockBackend() });
  await expect(
    e.run(wrap(`return await parallel(Array.from({length: 5000}, () => () => agent("x")));`)),
  ).rejects.toThrow(/at most 4096/);
});

test("pipeline() batch cap (4096) throws a clear error", async () => {
  const e = createEngine({ backend: new MockBackend() });
  await expect(
    e.run(wrap(`return await pipeline(Array.from({length: 5000}), it => it);`)),
  ).rejects.toThrow(/at most 4096/);
});

test("journal: resume returns cached results without hitting backend", async () => {
  const journal = new Journal();
  const b1 = new MockBackend({ respond: () => ({ text: "FIRST" }) });
  const e1 = createEngine({ backend: b1, journal });
  const r1 = await e1.run(wrap(`return await agent("stable");`));
  expect(r1.result).toBe("FIRST");
  expect(b1.calls.length).toBe(1);

  const b2 = new MockBackend({ respond: () => ({ error: "should not be called" }) });
  const e2 = createEngine({ backend: b2, journal });
  const r2 = await e2.run(wrap(`return await agent("stable");`));
  expect(r2.result).toBe("FIRST");
  expect(b2.calls.length).toBe(0);
  expect(r2.stats.cacheHits).toBe(1);
});

// ── review 2026-07-18 #3 — failures were journaled, so a resume replayed a
// permanent null instead of retrying the agent.
test("review #3: a FAILED agent() is not journaled — resume retries it", async () => {
  const journal = new Journal();
  const bad = new MockBackend({ respond: () => ({ error: "boom" }) });
  const e1 = createEngine({ backend: bad, journal });
  const r1 = await e1.run(wrap(`return (await agent("flaky")) === null;`));
  expect(r1.result).toBe(true);

  const good = new MockBackend({ respond: () => ({ text: "recovered" }) });
  const e2 = createEngine({ backend: good, journal });
  const r2 = await e2.run(wrap(`return await agent("flaky");`));
  expect(r2.result).toBe("recovered");
  expect(good.calls.length).toBe(1); // backend WAS hit — no null replay
});

// ── review 2026-07-18 #3 — within one LIVE run, identical (prompt, opts) calls
// must each hit the backend (judge panels / refuter votes), not collapse into
// one cached answer. Replay serves PRIOR-run entries only.
test("review #3: identical sequential calls in one run do NOT collapse", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b });
  const { result, stats } = await e.run(
    wrap(`const a = await agent("same"); const b = await agent("same"); return [a, b];`),
  );
  expect(result).toEqual(["x", "x"]);
  expect(b.calls.length).toBe(2);
  expect(stats.cacheHits).toBe(0);
});

// ── review 2026-07-18 #3 — the key folds in the RESOLVED phase: the same
// prompt under a different active phase() is a different slot, so a resumed
// script whose phases moved does not serve stale results across phases.
test("review #3: same prompt under different active phase() = different journal slots", async () => {
  const journal = new Journal();
  const b1 = new MockBackend({ respond: () => ({ text: "one" }) });
  await createEngine({ backend: b1, journal }).run(wrap(`phase("A"); return await agent("p");`));

  const b2 = new MockBackend({ respond: () => ({ text: "two" }) });
  const r = await createEngine({ backend: b2, journal }).run(
    wrap(`phase("B"); return await agent("p");`),
  );
  expect(r.result).toBe("two"); // phase B is NOT phase A's cached "one"
  expect(b2.calls.length).toBe(1);
});

// ── review 2026-07-18 #4 — engine state (budget/cap/phase) is closure-shared;
// overlapping run()s on one engine would cross-contaminate. Rejected instead.
test("review #4: overlapping run()s on one engine are rejected", async () => {
  const b = new MockBackend({ latencyMs: 30, respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b });
  const wf = e.load(wrap(`return await agent("slow");`));
  const first = wf.run(null);
  await expect(wf.run(null)).rejects.toThrow(/not reentrant/);
  await expect(first).resolves.toBe("x"); // the active run is unharmed
});

// ── review 2026-07-18 #5 — no default vm timeout let a pre-await while(true)
// block the host event loop forever. Sync-HEAD wall only (see sandbox.ts).
test("review #5: a pre-await infinite sync loop trips the sandbox timeout", async () => {
  const e = createEngine({ backend: new MockBackend(), sandboxTimeoutMs: 200 });
  await expect(e.run(wrap(`while (true) {}`))).rejects.toThrow(/timed out/i);
});

test("strict mode bans Date.now and Math.random (determinism)", async () => {
  const b = new MockBackend();
  const e = createEngine({ backend: b, strict: true });
  await expect(e.run(wrap(`Date.now();`))).rejects.toThrow(/unavailable in workflow scripts/);
  await expect(e.run(wrap(`Math.random();`))).rejects.toThrow(/unavailable in workflow scripts/);
  const e2 = createEngine({ backend: b, strict: false });
  const { result } = await e2.run(wrap(`return typeof Date.now() === "number";`));
  expect(result).toBe(true);
});

test("phase() labels subsequent agents; log() forwards messages", async () => {
  const phases: string[] = [],
    logs: string[] = [];
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({
    backend: b,
    onPhase: (p) => phases.push(p),
    onLog: (m) => logs.push(m),
  });
  await e.run(wrap(`phase("Find"); log("starting"); await agent("a");`));
  expect(phases).toEqual(["Find"]);
  expect(logs).toEqual(["starting"]);
  expect(b.calls[0].phase).toBe("Find");
});

test("args and meta are injected into the script", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b });
  const { result, meta } = await e.run(wrap(`return { got: args, name: meta.name };`), {
    args: { q: 42 },
  });
  expect(result).toEqual({ got: { q: 42 }, name: "t" });
  expect(meta.name).toBe("t");
});

test("provider/model/effort opts pass through to the backend spec", async () => {
  const b = new MockBackend({ respond: () => ({ text: "x" }) });
  const e = createEngine({ backend: b });
  await e.run(
    wrap(
      `await agent("x", { provider: "codex/gpt-5.4", model: "gpt-5.4", effort: "high", label: "L" });`,
    ),
  );
  expect(b.calls[0].provider).toBe("codex/gpt-5.4");
  expect(b.calls[0].model).toBe("gpt-5.4");
  expect(b.calls[0].effort).toBe("high");
});

test("engine bounds concurrent backend.run calls to maxConcurrency", async () => {
  let active = 0,
    peak = 0;
  const b = new MockBackend({ latencyMs: 5, respond: () => ({ text: "x" }) });
  const origRun = b.run.bind(b);
  b.run = async (spec) => {
    active++;
    peak = Math.max(peak, active);
    try {
      return await origRun(spec);
    } finally {
      active--;
    }
  };
  const e = createEngine({ backend: b, maxConcurrency: 3 });
  await e.run(
    wrap(`return await parallel(Array.from({length: 20}, (_,i) => () => agent("x"+i)));`),
  );
  expect(peak).toBeLessThanOrEqual(3);
  expect(b.calls.length).toBe(20);
});

test("engine owns the structured contract — reused prompts present in library", () => {
  expect(prompts.SUBAGENT_STRUCTURED_TOOL).toContain("StructuredOutput");
  expect(prompts.AGENTTYPE_STRUCTURED_NOTE).toContain("StructuredOutput");
  expect(prompts.structuredPersona({ type: "object" })).toContain("JSON Schema");
});

// ── ARCHITECTURE: dispose leak — the engine never called backend.dispose().
test("dispose() forwards to backend.dispose()", async () => {
  let disposed = false;
  class DBackend extends MockBackend {
    override async dispose(): Promise<void> {
      disposed = true;
    }
  }
  const e = createEngine({ backend: new DBackend({ respond: () => ({ text: "x" }) }) });
  await e.dispose();
  expect(disposed).toBe(true);
});

// ── ARCHITECTURE: error taxonomy — every workflow-layer error shares a
// WorkflowError base, so one `instanceof WorkflowError` catches the family.
test("error taxonomy: all workflow errors share the WorkflowError base", () => {
  expect(new prompts.WorkflowAgentCapError()).toBeInstanceOf(WorkflowError);
  expect(new prompts.WorkflowBudgetExceededError(1, 2)).toBeInstanceOf(WorkflowError);
  // (BlockedError/SkippedError retired with the artifact gate; PolicyError with
  // FlowPolicy; ExecError with the runner.ts paseo path.) names unchanged.
  expect(new prompts.WorkflowAgentCapError().name).toBe("WorkflowAgentCapError");
});
