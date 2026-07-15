/**
 * node:vm sandbox — run a workflow BODY in a fresh ECMAScript realm behind a
 * MARSHALLING boundary, so the untrusted script holds ONLY realm-native values.
 *
 * WHY A MARSHALLING BOUNDARY (not just codegen-off): node:vm's
 * `codeGeneration:{strings:false}` blocks eval / new Function / the
 * `x.constructor.constructor('...')()` escape ONLY for realm-native objects
 * (whose `.constructor` is the REALM's Function). If we inject a HOST object
 * (an agent fn, args, budget, or return a host result object), its prototype
 * chain reaches the HOST Function, whose codegen runs in the HOST context —
 * UNaffected by the realm's codegen flag. So `agent.constructor.constructor(
 * "return process")()` on a host-injected `agent` really did read host files.
 * The fix: NOTHING host-native is ever named by, or handed to, the script.
 *
 * HOW:
 *   - ONE host object (`__aw_bridge__`) is injected. An in-context BOOTSTRAP
 *     captures it in a realm closure, then DELETES it from the realm global, so
 *     the script can never name it.
 *   - The 8 workflow globals (agent/parallel/pipeline/phase/log/budget/args/
 *     meta) the script sees are all REALM-NATIVE (defined by the bootstrap).
 *     Their `.constructor` is the realm's Function -> codegen off -> throws.
 *   - DATA crossing host->realm (args, meta, every agent()/backend RESULT) is
 *     re-materialized realm-native: JSON string -> realm JSON.parse, so the
 *     objects the script touches have realm constructors. Primitives (budget
 *     numbers) are already realm-native (realm Number).
 *   - OPAQUE host values that must pass THROUGH the realm (e.g. a zod schema
 *     handed in via args, then back out via agent()'s opts) become numeric
 *     HANDLES: the realm holds `{__aw_handle:id}`, the real value stays in a
 *     host table and is swapped back host-side. The script can pass a handle
 *     around but can't reflect through it.
 *   - Errors from the host bridge come back as `{err:{name,message}}` and the
 *     realm wrapper rethrows a REALM Error - so a script that CATCHES an
 *     agent() failure gets a realm-native error, not a host Error whose
 *     `.constructor.constructor` would escape.
 *
 * WHAT THIS BUYS: the reviewer's exact exploit
 *   `agent.constructor.constructor("return process")()`
 * (and the same via args / budget / a RESULT object / computed-access) now
 * THROWS "Code generation from strings disallowed" inside the realm and cannot
 * reach host process/require/fs. This layer is now genuine containment for the
 * constructor-chain class of escape, not just casual reach.
 *
 * STILL NOT A HARD JAIL: node:vm is not an OS boundary (Node docs say so). The
 * marshalling closes the constructor-chain + string-eval vectors. Residual
 * risk lives in the vm engine itself; true per-worker isolation is Phase D
 * (paseo process jail). Defense in depth, three belts:
 *   - THIS layer: marshalling + codegen-off (no host handle reachable).
 *   - Phase E: static validator bans obvious escape tokens before run.
 *   - Phase D: real per-worker PROCESS isolation.
 */
import * as vm from "node:vm";

// codegen locked off for EVERY realm we build - eval / new Function / the
// `x.constructor.constructor('...')()` escape all throw inside the realm.
const LOCKED: vm.CreateContextOptions = { codeGeneration: { strings: false, wasm: false } };

/**
 * Finding 1 — evaluate an authored object LITERAL (e.g. `export const meta`)
 * inside a LOCKED, EMPTY realm instead of host `new Function`.
 *
 * The old `new Function("return (" + text + ")")()` ran the meta literal in the
 * HOST realm, so a meta like `{ name: (function(){ require('child_process')
 * .execSync('id'); return 't' })() }` executed host code just from LISTING a
 * workflow. Here the realm has NO injected globals: `require`/`process` resolve
 * to undefined (ReferenceError) and codegen is off, so a pure literal evaluates
 * fine but a malicious IIFE THROWS and reaches nothing host-side. 1s sync wall.
 */
export function evalLiteralInRealm(text: string): unknown {
  const ctx = vm.createContext({}, LOCKED);
  // Fix B — return PLAIN DATA, not a realm object. The old code handed the
  // evaluated realm object back to the HOST, which then read/JSON.stringify'd
  // it (registry/cli/engine) — executing any author getter/toJSON HOST-side
  // with NO timeout, so `{ get name(){ for(;;){} } }` hung `aw list` on mere
  // LISTING. Now we JSON.stringify INSIDE the realm under the 1s runInContext
  // wall: a looping getter runs in-realm and the timeout THROWS (bounded), then
  // JSON.parse host-side hands back inert data with no live getters.
  // HONEST NOTE: this closes the LIST/discovery DoS. A script you actually RUN
  // can still infinite-loop like any in-process runner — that residual needs
  // process isolation (Phase D), out of scope here.
  const json = vm.runInContext("JSON.stringify((" + text + "\n))", ctx, {
    filename: "meta-literal.js",
    timeout: 1000,
  }) as string | undefined;
  return json === undefined ? undefined : JSON.parse(json);
}

/**
 * The host side the sandbox forwards to. Exactly ONE object; the engine wires
 * its agent()/phase()/log()/budget closures in here. `agent` gets ALREADY
 * host-resolved opts (handles swapped back) and returns a plain result the
 * sandbox will JSON-marshal for the realm.
 */
export interface SandboxHost {
  agent(prompt: string, opts: Record<string, unknown>): Promise<unknown>;
  phase(name: string): void;
  log(msg: string): void;
  budgetSpent(): number;
  budgetRemaining(): number;
  budgetTotal: number | null;
}

/** Options for one sandboxed body run. */
export interface SandboxRunOpts {
  /** workflow body — meta already stripped by extractMeta(). */
  body: string;
  /** the ONE host bridge; the sandbox never injects any other host object. */
  host: SandboxHost;
  /** run args (host-native); marshalled realm-native for the `args` global. */
  args: unknown;
  /** workflow meta (host-native); marshalled realm-native for `meta`. */
  meta: unknown;
  /** single parallel()/pipeline() fan-out cap. */
  batchCap: number;
  /** strict mode shadows Date/Math with realm-native banned versions. */
  strict: boolean;
  dateBanMsg: string;
  randomBanMsg: string;
  /**
   * bound a runaway SYNC loop, in ms. CAVEAT: vm's timeout only catches the
   * synchronous head (code up to the first `await`). An async agent() wait is
   * NOT covered by this — don't overclaim it as a wall clock on the whole run.
   * Omit = no bound.
   */
  timeoutMs?: number;
  /** filename shown in stack traces. */
  filename?: string;
}

const HANDLE_KEY = "__aw_handle";

// a "plain" value is safe to deep-copy as data. anything else (class instance,
// function, Date, Map, ...) is an OPAQUE host object we must NOT expose to the
// script's reflection - it becomes a handle instead.
function isPlain(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

// marshal a host value into a JSON-safe clone. primitives + plain
// objects/arrays copy through; ANY non-plain host object (a zod schema, a
// function, a class instance) is parked in `table` and replaced with an opaque
// { __aw_handle: id } the realm can carry but not reflect through.
function marshalToHandles(value: unknown, table: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((v) => marshalToHandles(v, table));
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? handleFor(value, table) : value;
  }
  if (!isPlain(value)) return handleFor(value, table);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = marshalToHandles(v, table);
  return out;
}
function handleFor(value: unknown, table: unknown[]): Record<string, number> {
  const id = table.length;
  table.push(value);
  return { [HANDLE_KEY]: id };
}
// swap { __aw_handle: id } markers (round-tripped through JSON by the realm)
// back to the real host value from `table`. an out-of-range/forged id resolves
// to undefined - no host object leaks to the script, so it's not an escalation.
function resolveHandles(value: unknown, table: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveHandles(v, table));
  if (value === null || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  if (typeof rec[HANDLE_KEY] === "number" && Object.keys(rec).length === 1) {
    return table[rec[HANDLE_KEY] as number];
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = resolveHandles(v, table);
  return out;
}

// in-context BOOTSTRAP: captures the ONE host bridge, deletes it from the realm
// global, then defines the 8 REALM-NATIVE workflow globals over it. everything
// the script touches after this is realm-native (or a primitive / handle).
const BOOTSTRAP = `(() => {
  const __b = globalThis.__aw_bridge__;
  delete globalThis.__aw_bridge__;
  const J = JSON;
  const capMsg = (what, n) => what + "() received " + n + " items — a single parallel()/pipeline() call supports at most " + __b.batchCap + ". Split into multiple calls.";

  globalThis.agent = async (prompt, opts) => {
    // opts (realm object, maybe carrying a schema handle) -> JSON -> host
    // bridge -> JSON result -> realm parse. host errors come back as {err}
    // and rethrow as a REALM Error (no host Error handed to the script).
    const res = J.parse(await __b.agent(prompt, J.stringify(opts == null ? {} : opts)));
    if (res.err) { const e = new Error(res.err.message); e.name = res.err.name; throw e; }
    return res.ok;
  };
  // Fix A — parallel() is a BARRIER that NEVER rejects: a thunk that throws (or
  // whose agent errors) resolves to null in that slot, others still resolve.
  // (spec: parallel thunks map rejects to null, .filter(Boolean) before use.)
  globalThis.parallel = async (fns) => {
    if (fns.length > __b.batchCap) throw new Error(capMsg("parallel", fns.length));
    return Promise.all(fns.map(async (fn) => {
      try { return await fn(); } catch (_e) { return null; }
    }));
  };
  // Fix A — pipeline() flows each item through ALL stages INDEPENDENTLY, NO
  // barrier between stages: item A can be in stage 3 while item B is still in
  // stage 1 (wall-clock = slowest single-item chain, not sum-of-slowest-per-
  // stage). Every stage callback gets (prevResult, originalItem, index). A stage
  // that THROWS drops THAT item to null and skips its remaining stages; other
  // items proceed. First stage's prevResult IS the original item.
  globalThis.pipeline = async (items, ...stages) => {
    if (items.length > __b.batchCap) throw new Error(capMsg("pipeline", items.length));
    return Promise.all(items.map(async (item, index) => {
      let prev = item;
      for (const stage of stages) {
        try { prev = await stage(prev, item, index); }
        catch (_e) { return null; }  // drop this item, skip its remaining stages
      }
      return prev;
    }));
  };
  globalThis.phase = (name) => { __b.phase(String(name)); };
  globalThis.log = (msg) => { __b.log(String(msg)); };
  globalThis.args = J.parse(__b.argsJson);
  globalThis.meta = J.parse(__b.metaJson);
  // realm-native budget: methods forward to the host bridge and return
  // primitives (realm Number), so budget.constructor is the realm Object.
  globalThis.budget = {
    total: __b.budgetTotal,
    spent: () => __b.budgetSpent(),
    remaining: () => __b.budgetRemaining(),
  };
  if (__b.strict) {
    // realm-native banned Date/Math (determinism guard). defineProperty so the
    // shadow lands even though Date/Math already exist on the realm global.
    const BannedDate = function () { throw new Error(__b.dateBanMsg); };
    BannedDate.now = () => { throw new Error(__b.dateBanMsg); };
    Object.defineProperty(globalThis, "Date", { value: BannedDate, writable: true, configurable: true });
    const BannedMath = Object.create(Math);
    BannedMath.random = () => { throw new Error(__b.randomBanMsg); };
    Object.defineProperty(globalThis, "Math", { value: BannedMath, writable: true, configurable: true });
  }
})();`;

/**
 * Run `body` in a fresh vm realm behind the marshalling boundary.
 *
 * The body is wrapped in an async IIFE so top-level `await` works; the IIFE's
 * returned realm promise is awaited HOST-side and its value handed back. The
 * final result is realm-native (built by the script) and flows to the TRUSTED
 * host caller, so it is not re-marshalled.
 */
export async function runInSandbox(opts: SandboxRunOpts): Promise<unknown> {
  // per-run handle table shared by the args marshaller (fills it) and the
  // bridge.agent resolver (reads it).
  const table: unknown[] = [];
  const argsJson = JSON.stringify(marshalToHandles(opts.args, table) ?? null);
  const metaJson = JSON.stringify(opts.meta ?? null);

  const bridge = {
    argsJson,
    metaJson,
    batchCap: opts.batchCap,
    strict: opts.strict,
    dateBanMsg: opts.dateBanMsg,
    randomBanMsg: opts.randomBanMsg,
    budgetTotal: opts.host.budgetTotal,
    budgetSpent: (): number => opts.host.budgetSpent(),
    budgetRemaining: (): number => opts.host.budgetRemaining(),
    phase: (name: string): void => opts.host.phase(name),
    log: (msg: string): void => opts.host.log(msg),
    // NEVER rejects across the boundary: a host throw comes back as {err} JSON
    // so the realm wrapper can rethrow a REALM Error (host Error objects must
    // not reach the script - their .constructor.constructor would escape).
    agent: async (prompt: string, optsJson: string): Promise<string> => {
      try {
        const parsed = optsJson ? (JSON.parse(optsJson) as Record<string, unknown>) : {};
        const resolved = resolveHandles(parsed, table) as Record<string, unknown>;
        const result = await opts.host.agent(prompt, resolved);
        return JSON.stringify({ ok: result ?? null });
      } catch (e) {
        const err = e as { name?: string; message?: string };
        return JSON.stringify({
          err: { name: err?.name ?? "Error", message: err?.message ?? String(e) },
        });
      }
    },
  };

  const context = vm.createContext({ __aw_bridge__: bridge }, LOCKED);
  const wrapped = BOOTSTRAP + "\n;(async () => {\n" + opts.body + "\n})();";
  const runOpts: vm.RunningScriptOptions = { filename: opts.filename ?? "workflow.js" };
  if (opts.timeoutMs != null) runOpts.timeout = opts.timeoutMs;
  const promise = vm.runInContext(wrapped, context, runOpts) as Promise<unknown>;
  return await promise;
}
