// critique #3 — PROVE the vm realm removes the easy host handles.
// Every case runs a REAL script through the engine (the production path:
// extractMeta -> runInSandbox), or through runInSandbox directly, and asserts
// on observed behaviour — not prose. Cross-realm errors carry name
// "ReferenceError" but are NOT host `instanceof ReferenceError` (different
// realm), so we assert on .name / message, never host instanceof.
import { test, expect } from "vitest";
import { createEngine } from "../src/engine.js";
import { runInSandbox, evalLiteralInRealm } from "../src/sandbox.js";
import { MockBackend } from "../src/backends/mock.js";

const wrap = (body: string): string =>
  `export const meta = { name: "t", description: "d", phases: [] };\n${body}`;
// these tests probe the RUNTIME belt (the vm realm) directly, so they feed
// deliberately-malicious scripts (process/require/eval/constructor-chain...)
// through the engine. turn the §11 STATIC validator OFF here so the probe
// REACHES the vm — defense-in-depth: two INDEPENDENT layers, tested apart.
const mkEngine = (strict = true) =>
  createEngine({
    backend: new MockBackend({ respond: () => ({ text: "R" }) }),
    strict,
    validate: false,
  });

// 1 — process is not a name in the realm
test("process is not in scope (typeof -> undefined)", async () => {
  const { result } = await mkEngine().run(wrap(`return typeof process;`));
  expect(result).toBe("undefined");
});

// 2 — process.exit rejects AND host process does NOT exit (test keeps running)
test("process.exit(1) rejects; host survives", async () => {
  await expect(mkEngine().run(wrap(`process.exit(1);`))).rejects.toThrow(/process is not defined/);
  // if the host had actually exited, this line never runs -> the assertion
  // below is the living proof the host process is still alive.
  expect(1 + 1).toBe(2);
});

// 3 — require is undefined for both node: and bare specifiers
test("require('node:fs') and require('fs') reject", async () => {
  await expect(mkEngine().run(wrap(`return require('node:fs');`))).rejects.toThrow(
    /require is not defined/,
  );
  await expect(mkEngine().run(wrap(`return require('fs');`))).rejects.toThrow(
    /require is not defined/,
  );
});

// 4 — no host reachable through globalThis / global
test("globalThis?.process undefined; global not present", async () => {
  const a = await mkEngine().run(wrap(`return globalThis?.process ?? "none";`));
  expect(a.result).toBe("none");
  const b = await mkEngine().run(wrap(`return typeof global;`));
  expect(b.result).toBe("undefined");
});

// 5 — determinism ban preserved under vm (strict) / real under non-strict
test("strict mode bans Date.now / new Date() / Math.random()", async () => {
  const e = mkEngine(true);
  await expect(e.run(wrap(`return Date.now();`))).rejects.toThrow(
    /unavailable in workflow scripts/,
  );
  await expect(e.run(wrap(`return new Date();`))).rejects.toThrow(
    /unavailable in workflow scripts/,
  );
  await expect(e.run(wrap(`return Math.random();`))).rejects.toThrow(
    /unavailable in workflow scripts/,
  );
});
test("non-strict mode restores real Date / Math in the realm", async () => {
  const e = mkEngine(false);
  const a = await e.run(wrap(`return typeof Date.now();`));
  expect(a.result).toBe("number");
  const b = await e.run(wrap(`return typeof new Date().getTime();`));
  expect(b.result).toBe("number");
  const c = await e.run(wrap(`const r = Math.random(); return r >= 0 && r < 1;`));
  expect(c.result).toBe(true);
});

// 6 — a NORMAL script still runs correctly through the realm
test("normal script (agent/parallel/phase/log/args) runs through vm", async () => {
  const logs: string[] = [],
    phases: string[] = [];
  const backend = new MockBackend({ respond: (s) => ({ text: s.label ?? "x" }) });
  const e = createEngine({
    backend,
    onLog: (m) => logs.push(m),
    onPhase: (p) => phases.push(p),
    validate: false,
  });
  const { result } = await e.run(
    wrap(`
    phase("Work");
    log("go");
    const outs = await parallel([0, 1].map((i) => () => agent("t", { label: "L" + i })));
    return { outs, tag: args.tag };
  `),
    { args: { tag: "ok" } },
  );
  expect(result).toEqual({ outs: ["L0", "L1"], tag: "ok" });
  expect(phases).toEqual(["Work"]);
  expect(logs).toEqual(["go"]);
});

// standard JS built-ins ARE present in the bare realm (JSON/Map/Set/Promise..)
test("standard built-ins present in the realm; Node globals absent", async () => {
  const { result } = await mkEngine().run(
    wrap(`
    return {
      json: typeof JSON, map: typeof Map, set: typeof Set,
      promise: typeof Promise, arr: typeof Array, obj: typeof Object,
      buffer: typeof Buffer, url: typeof URL, fetch: typeof fetch,
    };
  `),
  );
  expect(result).toEqual({
    json: "object",
    map: "function",
    set: "function",
    promise: "function",
    arr: "function",
    obj: "function",
    buffer: "undefined",
    url: "undefined",
    fetch: "undefined",
  });
});

// runInSandbox direct API (new marshalling contract) — a single host bridge,
// realm-native globals, JSON-marshalled args/results. sync timeout bounds a
// runaway SYNC loop (NOT async waits — see sandbox.ts caveat).
const stubHost = (agent = async (): Promise<unknown> => "R") => ({
  agent,
  phase: (): void => {},
  log: (): void => {},
  budgetSpent: (): number => 0,
  budgetRemaining: (): number => Infinity,
  budgetTotal: null,
});
const baseOpts = {
  host: stubHost(),
  args: null,
  meta: {},
  batchCap: 4096,
  strict: true,
  dateBanMsg: "date banned",
  randomBanMsg: "random banned",
};
test("runInSandbox marshals args + returns the body value", async () => {
  const v = await runInSandbox({ ...baseOpts, args: { n: 41 }, body: `return args.n + 1;` });
  expect(v).toBe(42);
  // an undefined name is still a realm ReferenceError.
  await expect(runInSandbox({ ...baseOpts, body: `return nope();` })).rejects.toThrow(
    /nope is not defined/,
  );
});
test("runInSandbox timeout aborts a runaway sync loop", async () => {
  await expect(
    runInSandbox({ ...baseOpts, body: `while (true) {}`, timeoutMs: 50 }),
  ).rejects.toThrow(/timed out/);
});

// ── Fix A (HIGH) — the realm-native parallel()/pipeline() now match the
// documented Workflow contract (spec ~561-562): parallel maps a throwing thunk
// to null (never rejects); pipeline flows each item through ALL stages
// INDEPENDENTLY (no barrier), a throwing stage drops THAT item to null + skips
// its rest, and every stage gets (prevResult, originalItem, index).
test("Fix A: parallel() maps a throwing thunk to null; the call never rejects", async () => {
  const v = await runInSandbox({
    ...baseOpts,
    body: `return await parallel([() => { throw new Error("boom"); }, () => agent("ok"), () => 7]);`,
  });
  expect(v).toEqual([null, "R", 7]); // throwing slot -> null, others resolve
});

test("Fix A: pipeline() drops a throwing item to null + skips its rest; others complete", async () => {
  const v = await runInSandbox({
    ...baseOpts,
    body:
      `return await pipeline([1, 2],\n` +
      `  (prev) => { if (prev === 1) throw new Error("x"); return prev; },\n` +
      `  (prev) => "s2:" + prev);`,
  });
  // item 1 throws in stage 1 -> null, stage 2 SKIPPED; item 2 flows all the way.
  expect(v).toEqual([null, "s2:2"]);
});

test("Fix A: pipeline() stage receives (prevResult, originalItem, index)", async () => {
  const v = await runInSandbox({
    ...baseOpts,
    body:
      `return await pipeline(["a", "b"],\n` +
      `  (prev) => prev + "!",\n` +
      `  (prev, orig, idx) => prev + ":" + orig + ":" + idx);`,
  });
  // stage 2 sees prevResult ("a!"/"b!"), originalItem ("a"/"b"), index (0/1).
  expect(v).toEqual(["a!:a:0", "b!:b:1"]);
});

// ── Fix B (HIGH) — evalLiteralInRealm now returns PLAIN DATA (serialized INSIDE
// the realm under the 1s wall), so a malicious author getter can't run HOST-side
// with no timeout. An infinite-loop getter hangs IN-realm and the 1s wall throws.
test("Fix B: an infinite-loop meta getter THROWS within the 1s wall (no host hang)", () => {
  const start = Date.now();
  expect(() => evalLiteralInRealm(`{ get name(){ for(;;){} } }`)).toThrow();
  expect(Date.now() - start).toBeLessThan(3000); // bounded by the in-realm timeout
});

test("Fix B: a normal literal evaluates to plain data", () => {
  expect(evalLiteralInRealm(`{ name: "ok", n: 1 + 2 }`)).toEqual({ name: "ok", n: 3 });
});

// codeGeneration OFF — eval / Function-constructor / new Function all throw
// inside the realm. This kills the constructor-chain string-eval escape.
test("eval() rejects (code generation disallowed)", async () => {
  await expect(mkEngine().run(wrap(`return eval('1 + 1');`))).rejects.toThrow(
    /[Cc]ode generation from strings disallowed/,
  );
});
test("constructor-chain Function escape is blocked; process not leaked", async () => {
  // if the escape worked it would resolve to "object"; it must REJECT instead.
  await expect(
    mkEngine().run(wrap(`return (function(){}).constructor('return typeof process')();`)),
  ).rejects.toThrow(/[Cc]ode generation from strings disallowed/);
});
test("new Function() rejects (code generation disallowed)", async () => {
  await expect(mkEngine().run(wrap(`return new Function('return 1')();`))).rejects.toThrow(
    /[Cc]ode generation from strings disallowed/,
  );
});

// ── Finding 2 (CRITICAL) — the marshalling boundary. The injected globals +
// returned results are now REALM-NATIVE, so their .constructor is the realm's
// Function (codegen off -> throws). These are the reviewer's EXACT exploits,
// now asserting they FAIL to escape. The old sandbox (host-object injection)
// returned real host state here.
const CODEGEN = /[Cc]ode generation from strings disallowed/;

test("Finding 2: agent.constructor.constructor cannot reach host process", async () => {
  // the reviewer's exact exploit shape — used to return real host file bytes.
  await expect(
    mkEngine().run(wrap(`return agent.constructor.constructor("return process")();`)),
  ).rejects.toThrow(CODEGEN);
});

test("Finding 2: reviewer's exact /etc/hostname read is blocked", async () => {
  await expect(
    mkEngine().run(
      wrap(
        `return agent.constructor.constructor(` +
          `"return process.getBuiltinModule('fs').readFileSync('/etc/hostname','utf8')")();`,
      ),
    ),
  ).rejects.toThrow(CODEGEN);
});

test("Finding 2: injected args cannot escape via constructor.constructor", async () => {
  const e = createEngine({
    backend: new MockBackend({ respond: () => ({ text: "R" }) }),
    validate: false,
  });
  await expect(
    e.run(wrap(`return args.constructor.constructor("return process")();`), { args: { a: 1 } }),
  ).rejects.toThrow(CODEGEN);
});

test("Finding 2: injected budget cannot escape via constructor.constructor", async () => {
  await expect(
    mkEngine().run(wrap(`return budget.constructor.constructor("return process")();`)),
  ).rejects.toThrow(CODEGEN);
});

test("Finding 2: a RESULT object cannot escape via constructor.constructor", async () => {
  const schema = { type: "object", required: ["a"], properties: { a: { type: "number" } } };
  const b = new MockBackend({ respond: () => ({ text: '{"a":1}' }) });
  const e = createEngine({ backend: b, validate: false });
  await expect(
    e.run(
      wrap(
        `const r = await agent("x", { schema: ${JSON.stringify(schema)} });\n` +
          `return r.constructor.constructor("return process")();`,
      ),
    ),
  ).rejects.toThrow(CODEGEN);
});

test("Finding 2: computed-access agent['constr'+'uctor'] is also blocked", async () => {
  await expect(
    mkEngine().run(wrap(`return agent["constr"+"uctor"].constructor("return process")();`)),
  ).rejects.toThrow(CODEGEN);
});

test("Finding 2: a NORMAL script (agent/budget/args, returns object) still works", async () => {
  const b = new MockBackend({ respond: (s) => ({ text: s.label ?? "x" }) });
  const e = createEngine({ backend: b, budgetTokens: 10000, validate: false });
  const { result } = await e.run(
    wrap(`
    const a = await agent("t", { label: "L0" });
    return { a, total: budget.total, tag: args.tag };
  `),
    { args: { tag: "ok" } },
  );
  expect(result).toEqual({ a: "L0", total: 10000, tag: "ok" });
});
