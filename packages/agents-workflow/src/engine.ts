/**
 * Core workflow engine — backend-agnostic.
 *
 * Executes a Claude-style workflow script (`export const meta` + a body that
 * uses 8 globals) against an injected AgentBackend. The engine owns:
 *   - the 8 globals: agent/parallel/pipeline/phase/log/budget/args/meta
 *   - persona assembly (prompt library) prepended to every agent prompt
 *   - the structured-output contract (prompt -> backend -> validate -> retry)
 *   - concurrency limiting, agent caps, per-batch caps, token budget
 *   - journal/resume caching and determinism guards (strict mode)
 *
 * It imports NO concrete backend. Wire one in via createEngine({ backend }).
 */
import * as os from "node:os";
import pLimit from "p-limit";
import { AgentBackend, type AgentSpec, type AgentUsage, type Effort } from "./backend.js";
import {
  SUBAGENT_TEXT,
  AGENTTYPE_NOTE,
  structuredPersona,
  structuredRetrySuffix,
  WorkflowAgentCapError,
  WorkflowBudgetExceededError,
  DATE_BAN_MESSAGE,
  RANDOM_BAN_MESSAGE,
} from "./prompt-library.js";
import { normalizeSchema, tryParseJson, type SchemaInput } from "./schema-normalize.js";
// every workflow authors INLINE JSON Schema objects (the Claude-Workflow way);
// the schema seam (schema-normalize.ts) converts them to zod via z.fromJSONSchema
// (native interop, no third-party validator) for the structured-reply check.
import { defaultConcurrency } from "./limit.js";
import { Journal, agentKey } from "./journal.js";
import { runInSandbox, evalLiteralInRealm } from "./sandbox.js";
// §11 safety layer: the static script validator (BELT behind the sandbox).
// (FlowPolicy — the runtime role-ordering belt — was retired.)
import { validateScript } from "./validator.js";
import { WorkflowError } from "./errors.js";

export const AGENT_CAP = 1000; // k0y
export const BATCH_CAP = 4096; // single parallel()/pipeline() fan-out cap
const DEFAULT_EST_TOKENS = 512; // rough per-agent estimate when usage absent

/** Options accepted by the `agent()` global. */
export interface AgentCallOpts {
  label?: string;
  phase?: string;
  schema?: SchemaInput;
  model?: string;
  effort?: Effort;
  provider?: string;
  isolation?: string;
  agentType?: string;
  labels?: Record<string, string>;
  maxRetries?: number;
}

export type AgentFn = (prompt: string, opts?: AgentCallOpts) => Promise<unknown>;
export type ParallelFn = <T>(fns: Array<() => Promise<T> | T>) => Promise<T[]>;
export type PipelineFn = (
  items: unknown[],
  ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>
) => Promise<unknown[]>;
export type PhaseFn = (name: string) => void;
export type LogFn = (msg: string) => void;

export interface Budget {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
  [k: string]: unknown;
}

/**
 * A per-agent lifecycle event — the observability seam for live UI rendering.
 * Fired in the ENGINE (not the backend) so cache hits (resume) are covered too,
 * which a backend decorator would miss (they short-circuit before backend.run).
 *
 * State machine per `id`:  queued → start → (retry*) → complete | error.
 * A cache hit emits start+complete back-to-back with `cached: true`.
 */
export interface AgentEvent {
  /** Unique, monotonic per agent() call (incl. cache hits) — the stable UI node id. */
  id: number;
  type: "queued" | "start" | "retry" | "complete" | "error";
  /** opts.label, if the flow set one. */
  label?: string;
  /** Resolved phase: opts.phase ?? the active phase() ?? undefined. */
  phase?: string;
  /** Model OVERRIDE (opts.model); undefined = inherits the session/backend default. */
  model?: string;
  /** true when served from the resume journal WITHOUT running the backend. */
  cached?: boolean;
  /** Structured-output retry attempt number (1-based), on type "retry". */
  attempt?: number;
  /** Token usage, on type "complete" when the backend reported it. */
  usage?: AgentUsage;
  /** Error message, on type "error". */
  error?: string;
}

export interface EngineConfig {
  backend: AgentBackend;
  maxConcurrency?: number;
  agentCap?: number;
  /** null = no token budget. */
  budgetTokens?: number | null;
  /** ban Date.now/Math.random for resume determinism. */
  strict?: boolean;
  journal?: Journal;
  onLog?: (msg: string) => void;
  onPhase?: (phase: string) => void;
  /** Per-agent lifecycle events for live UI (queued/start/retry/complete/error). */
  onAgentEvent?: (ev: AgentEvent) => void;
  // §11 static validator gate. default true — engine.run/load rejects a script
  // that trips validateScript BEFORE loading it. built-ins all pass.
  validate?: boolean;
}

export interface EngineStats {
  agentCalls: number;
  cacheHits: number;
  structuredRetries: number;
  budgetDropped: number;
}

export interface RunResult {
  meta: WorkflowMeta;
  result: unknown;
  stats: EngineStats;
  budget: { total: number | null; spent: number };
}

export interface LoadedWorkflow {
  meta: WorkflowMeta;
  run: (args: unknown) => Promise<unknown>;
}

export interface Engine {
  run(source: string, opts?: { args?: unknown }): Promise<RunResult>;
  load(source: string): LoadedWorkflow;
  /** tear-down hook — forwards to backend.dispose() (sockets/processes). */
  dispose(): Promise<void>;
  readonly stats: EngineStats;
  readonly budget: Budget;
  readonly backend: AgentBackend;
}

export function createEngine(cfg: EngineConfig): Engine {
  if (!cfg || !(cfg.backend instanceof AgentBackend))
    throw new Error("createEngine requires an AgentBackend");
  const backend = cfg.backend;
  // Swap 2: p-limit is the limiter now. Only agent()'s backend.run consumes a
  // slot; parallel()/pipeline() do NOT wrap callbacks (would deadlock).
  const limit = pLimit(cfg.maxConcurrency ?? defaultConcurrency(os.cpus().length));
  const agentCap = cfg.agentCap ?? AGENT_CAP;
  const strict = cfg.strict ?? true;
  const journal = cfg.journal ?? new Journal();
  const logFn = cfg.onLog ?? ((): void => {});
  const phaseFn = cfg.onPhase ?? ((): void => {});
  // per-agent lifecycle emitter + a monotonic instance id (assigned to EVERY
  // agent() call incl. cache hits, so the UI has a stable node id per call).
  const agentEvt = cfg.onAgentEvent ?? ((): void => {});
  let agentSeq = 0;
  // §11: static-validate gate flag.
  const doValidate = cfg.validate !== false;

  const budget: Budget & { _spent: number } = {
    total: cfg.budgetTokens ?? null,
    _spent: 0,
    spent() {
      return this._spent;
    },
    remaining() {
      return this.total == null ? Infinity : Math.max(0, this.total - this._spent);
    },
  };

  let agentCalls = 0;
  let currentPhase: string | null = null;
  const stats: EngineStats = {
    agentCalls: 0,
    cacheHits: 0,
    structuredRetries: 0,
    budgetDropped: 0,
  };

  // Fix C — budget/agent-cap counters are per-ENGINE (built once above),
  // so a prior run()'s spent tokens + cap count
  // would LEAK into the next run() on the same engine. Reset them at the START
  // of each run. The JOURNAL is intentionally NOT reset (resume depends on it).
  function resetRunState(): void {
    agentCalls = 0;
    currentPhase = null;
    budget._spent = 0;
    stats.agentCalls = 0;
    stats.cacheHits = 0;
    stats.structuredRetries = 0;
    stats.budgetDropped = 0;
  }

  // ---- persona + spec assembly ----
  function personaFor(opts: AgentCallOpts): string {
    // schema path never reaches here (agent() routes it to structuredCall).
    if (opts.agentType) return SUBAGENT_TEXT + AGENTTYPE_NOTE;
    return SUBAGENT_TEXT;
  }
  function toSpec(fullPrompt: string, opts: AgentCallOpts): AgentSpec {
    return {
      prompt: fullPrompt,
      label: opts.label,
      phase: opts.phase ?? currentPhase ?? undefined,
      model: opts.model,
      effort: opts.effort,
      provider: opts.provider,
      isolation: opts.isolation,
      labels: opts.labels,
    };
  }

  // ---- the structured loop (engine-owned, backend-agnostic) ----
  // Swap 1: schema is normalized ONCE (zod or JSON-Schema object) into
  // { jsonSchema, validate }; the persona uses jsonSchema, the check uses validate.
  // returns the parsed value AND the token `spent` it accumulated, so the
  // caller reconciles the budget ONCE (Finding 4/5) instead of this loop
  // touching budget._spent mid-flight.
  async function structuredCall(
    id: number,
    prompt: string,
    opts: AgentCallOpts & { schema: SchemaInput },
  ): Promise<{ value: unknown; spent: number }> {
    const norm = normalizeSchema(opts.schema);
    let suffix = "";
    let spent = 0;
    const maxRetries = opts.maxRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const spec = toSpec(
        structuredPersona(norm.jsonSchema) + "\n\n---\n\n" + prompt + suffix,
        opts,
      );
      const r = await backend.run(spec);
      const text = r && !r.error ? (r.text ?? "") : "";
      // Finding 4 — charge each attempt its REAL usage; only fall back to the
      // flat estimate for an attempt the backend gave no usage for.
      spent += r?.usage?.outputTokens || DEFAULT_EST_TOKENS;
      const parsed = tryParseJson(text);
      if (parsed.ok) {
        const errs = norm.validate(parsed.value);
        if (errs.length === 0) return { value: parsed.value, spent };
        suffix = structuredRetrySuffix("schema validation failed: " + errs.join("; "));
      } else {
        suffix = structuredRetrySuffix("not valid JSON: " + parsed.err);
      }
      if (attempt < maxRetries) {
        stats.structuredRetries++;
        agentEvt({
          id,
          type: "retry",
          label: opts.label,
          phase: opts.phase ?? currentPhase ?? undefined,
          model: opts.model,
          attempt: attempt + 1,
        });
      }
    }
    return { value: null, spent }; // all retries failed -> agent() returns null
  }

  // ---- the agent() primitive ----
  const agent: AgentFn = async (rawPrompt, rawOpts = {}) => {
    if (typeof rawPrompt !== "string") throw new Error("agent() requires a string prompt");
    const prompt = rawPrompt;
    const opts = rawOpts;
    const id = ++agentSeq;
    const lbl = opts.label;
    const ph = opts.phase ?? currentPhase ?? undefined;
    const mdl = opts.model;

    const key = agentKey(prompt, opts);
    if (journal.has(key)) {
      stats.cacheHits++;
      const cached = journal.get(key);
      // a resume cache hit never runs the backend — emit start+complete so the
      // UI still renders the (instantly done) node; cached:true distinguishes it.
      agentEvt({ id, type: "start", label: lbl, phase: ph, model: mdl, cached: true });
      agentEvt({ id, type: "complete", label: lbl, phase: ph, model: mdl, cached: true });
      return cached;
    }

    if (++agentCalls > agentCap) throw new WorkflowAgentCapError();
    stats.agentCalls = agentCalls;

    // Finding 5 — atomic check-and-RESERVE. bump _spent by a flat estimate
    // SYNCHRONOUSLY, before the first await, so N concurrent launches under
    // parallel() each see the prior reservations (single-threaded: the reserve
    // runs to completion before the next agent()'s reserve) and can't all clear
    // one stale pre-check then overshoot. throw when NO budget remains.
    const budgeted = budget.total != null;
    if (budgeted) {
      if (budget._spent >= (budget.total as number))
        throw new WorkflowBudgetExceededError(budget._spent, budget.total as number);
      budget._spent += DEFAULT_EST_TOKENS;
    }

    // `charge` = what we ACTUALLY spent; reconciled against the reservation in
    // the finally. Finding 4: real usage when the backend reported it, the flat
    // estimate ONLY for a call with no usage (no more usage + 512 double-count).
    // queued = created + waiting for a concurrency slot (the limit() boundary);
    // start fires INSIDE the limiter callback once the slot is actually acquired.
    agentEvt({ id, type: "queued", label: lbl, phase: ph, model: mdl });

    let result: unknown;
    let charge = DEFAULT_EST_TOKENS;
    let errorMsg: string | undefined;
    let usage: AgentUsage | undefined;
    try {
      if (opts.schema) {
        const sc = await limit(() => {
          agentEvt({ id, type: "start", label: lbl, phase: ph, model: mdl });
          return structuredCall(id, prompt, opts as AgentCallOpts & { schema: SchemaInput });
        });
        result = sc.value;
        charge = sc.spent;
        if (sc.value === null) errorMsg = "structured output failed after retries";
        else usage = { outputTokens: sc.spent };
      } else {
        result = await limit(async (): Promise<unknown> => {
          agentEvt({ id, type: "start", label: lbl, phase: ph, model: mdl });
          const spec = toSpec(personaFor(opts) + "\n\n---\n\n" + prompt, opts);
          const r = await backend.run(spec);
          charge = r?.usage?.outputTokens || DEFAULT_EST_TOKENS;
          usage = r?.usage;
          if (!r || r.error) errorMsg = r?.error || "agent returned no result";
          return r && !r.error ? (r.text ?? null) : null;
        });
      }
    } catch (e) {
      // a THROWN backend (rare — mock/paseo RESOLVE with {error}) still gets an
      // error event, then re-throw to preserve behavior (parallel maps it to null).
      errorMsg = (e as Error)?.message ?? String(e);
      throw e;
    } finally {
      // reconcile: swap the up-front reservation for the real charge.
      if (budgeted) budget._spent += charge - DEFAULT_EST_TOKENS;
      // terminal event: error when the backend errored / threw / retries died,
      // else complete. Fired in `finally` so a thrown backend is covered too.
      if (errorMsg !== undefined)
        agentEvt({ id, type: "error", label: lbl, phase: ph, model: mdl, error: errorMsg });
      else agentEvt({ id, type: "complete", label: lbl, phase: ph, model: mdl, usage });
    }
    journal.record(key, result);
    return result;
  };

  // ---- phase / log ----
  // NOTE: parallel()/pipeline() are NOT host closures anymore — they are
  // REALM-NATIVE (defined by the sandbox bootstrap) so their .constructor is
  // the realm's, blocked by codegen-off (Finding 2). They still consume NO
  // limiter slot; concurrency stays globally bounded because every leaf is an
  // agent() whose backend.run self-limits host-side.
  const phase: PhaseFn = (name) => {
    currentPhase = name;
    phaseFn(name);
  };
  const log: LogFn = (msg) => {
    logFn(String(msg));
  };

  /** Load a workflow script: extract meta + run the body in a vm realm. */
  function load(source: string): LoadedWorkflow {
    // §11 static belt: reject a script that trips the validator BEFORE loading
    // it (default on; built-ins all pass). the vm sandbox is still the REAL
    // containment — this just fails obvious escapes fast, with a clear list.
    if (doValidate) {
      const v = validateScript(source);
      if (!v.ok)
        throw new WorkflowError(
          `workflow rejected by static validator (${v.violations.length} violation(s)): ` +
            v.violations.map((x) => `${x.rule}@${x.index} "${x.snippet}"`).join("; "),
        );
    }
    const { meta, body } = extractMeta(source);
    // the sandbox injects ONE host bridge and marshals args/meta/results
    // realm-native (Finding 2). strict mode shadows Date/Math with realm-native
    // banned versions inside the bootstrap. See sandbox.ts for the containment
    // story (real for the constructor-chain escape; Phase D finishes the belt).
    return {
      meta,
      run: async (args: unknown): Promise<unknown> => {
        // Fix C — fresh per-run state (budget/cap) so no leak across
        // sequential run()s on one engine. Journal stays (resume needs it).
        resetRunState();
        try {
          return await runInSandbox({
            body,
            host: {
              agent,
              phase,
              log,
              budgetSpent: () => budget.spent(),
              budgetRemaining: () => budget.remaining(),
              budgetTotal: budget.total,
            },
            args,
            meta,
            batchCap: BATCH_CAP,
            strict,
            dateBanMsg: DATE_BAN_MESSAGE,
            randomBanMsg: RANDOM_BAN_MESSAGE,
          });
        } catch (e) {
          // errors cross the sandbox boundary as REALM Errors (name+message
          // preserved). rehydrate the known workflow-error classes so a HOST
          // caller's `instanceof WorkflowBudgetExceededError` etc. still holds.
          throw rehydrateWorkflowError(e);
        }
      },
    };
  }

  /** Run a workflow script end-to-end. */
  async function run(source: string, opts: { args?: unknown } = {}): Promise<RunResult> {
    const wf = load(source);
    const result = await wf.run(opts.args ?? null);
    return {
      meta: wf.meta,
      result,
      stats: { ...stats },
      budget: { total: budget.total, spent: budget._spent },
    };
  }

  // tear-down hook: forward to the backend so it can release sockets/processes.
  async function dispose(): Promise<void> {
    await backend.dispose();
  }

  return { run, load, dispose, stats, budget, backend };
}

// a workflow error thrown deep in a script crosses the vm boundary as a REALM
// Error (its .constructor is the realm's, not host) - so host `instanceof
// WorkflowBudgetExceededError` would fail. rebuild the known classes from the
// preserved name/message so the HOST boundary keeps its error taxonomy. an
// unknown name (ordinary script TypeError/ReferenceError) passes through as-is.
function rehydrateWorkflowError(e: unknown): unknown {
  const err = e as { name?: string; message?: string } | null;
  if (!err || typeof err.name !== "string" || typeof err.message !== "string") return e;
  let host: Error | null = null;
  switch (err.name) {
    case "WorkflowAgentCapError":
      host = new WorkflowAgentCapError();
      break;
    case "WorkflowBudgetExceededError":
      host = new WorkflowBudgetExceededError(0, 0);
      break;
    default:
      return e;
  }
  host.message = err.message; // keep the faithful message for regex assertions
  return host;
}

/** Extract `export const meta = {...}` and return the remaining body. */
export function extractMeta(source: string): { meta: WorkflowMeta; body: string } {
  const marker = source.indexOf("export const meta");
  if (marker < 0) throw new Error("workflow script must begin with `export const meta = {...}`");
  const eq = source.indexOf("=", marker);
  const open = source.indexOf("{", eq);
  if (open < 0) throw new Error("meta must be an object literal");
  let depth = 0,
    i = open,
    inStr: string | null = null,
    esc = false;
  for (; i < source.length; i++) {
    const c = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const metaText = source.slice(open, i);
  let meta: WorkflowMeta;
  // Finding 1 — eval the meta literal in a LOCKED, EMPTY vm realm, NOT host
  // `new Function`. A malicious meta (`{ name: (function(){ require('child_
  // process')... })() }`) executed host code on mere LISTING via the old
  // host-scope eval; in the empty realm require/process are undefined and
  // codegen is off, so it throws and reaches nothing host-side.
  try {
    meta = evalLiteralInRealm(metaText) as WorkflowMeta;
  } catch (e) {
    throw new Error("failed to evaluate meta literal: " + (e as Error).message);
  }
  const body = source.slice(0, marker) + source.slice(i);
  return { meta, body };
}
