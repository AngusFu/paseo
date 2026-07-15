// Ambient TypeScript types for authoring *.flow.js / *.workflow.js scripts.
//
// A flow runs in the engine sandbox with 8 INJECTED globals and NO imports.
// Editors normally see the bare `agent` / `phase` / `args` as `any`. Reference
// this file from the TOP of a flow to get IntelliSense on the primitives:
//
//   /// <reference path="../../workflow.d.ts" />   // path is relative to the flow
//   /** @type {WorkflowMeta} */
//   export const meta = { name: 'my-flow', description: '...', phases: [{ title: 'Scan' }] }
//
//   phase('Scan')                                   // typed
//   const r = await agent('find X', { schema: {...}, phase: 'Scan' })  // opts autocompleted
//   const outs = await parallel(items.map(i => () => agent(prompt(i))))
//
// The reference path is relative to the flow FILE:
//   - builtin flows  workflows/builtin/*.flow.js   -> `../../workflow.d.ts`
//   - host scif flows .claude/workflows/*.flow.js  -> `../tools/agents-workflow/workflow.d.ts`
//
// SELF-CONTAINED on purpose (no imports) so it resolves from any flow location,
// in this repo and after agents-workflow is extracted to its own package. The
// shapes are hand-mirrored from src/engine.ts (AgentCallOpts / AgentFn /
// ParallelFn / PipelineFn / Budget / WorkflowMeta) — the 8-primitive Claude
// Workflow contract is stable, so keep this in sync by hand if those change.

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Options for an `agent()` call. */
interface AgentCallOpts {
  /** Human/UI label shown in the progress tree (defaults to a generated one). */
  label?: string;
  /** Progress-group phase this agent is filed under. */
  phase?: string;
  /** Inline JSON Schema (or a zod schema) — forces validated structured output. */
  schema?: object;
  /** Model override; omit to inherit the session/main-loop model. */
  model?: string;
  /** Reasoning effort; omit to inherit the session effort. */
  effort?: Effort;
  /** Backend/provider override. */
  provider?: string;
  /** `"worktree"` runs the agent in a fresh isolated git worktree. */
  isolation?: string;
  /** Custom subagent type (resolved from the agent registry). */
  agentType?: string;
  /** Extra key/value labels. */
  labels?: Record<string, string>;
  /** Per-call retry cap for structured-output validation. */
  maxRetries?: number;
}

/** The run's token budget. `total` is null when no `+N`-style target was set. */
interface Budget {
  readonly total: number | null;
  /** Output tokens spent this run so far (shared across the main loop + workflows). */
  spent(): number;
  /** `max(0, total - spent())`, or Infinity when no target was set. */
  remaining(): number;
}

/** The `export const meta` literal every flow declares (must be a pure literal). */
interface WorkflowMeta {
  name?: string;
  description?: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
  [k: string]: unknown;
}

// ─────────────────────────── the 8 injected globals ───────────────────────────

/**
 * Dispatch a subagent.
 * - without `schema` → resolves to the agent's final text (`string`), or `null` if it was skipped / died.
 * - with `schema` → resolves to the validated object (typed `unknown`; cast to your shape).
 */
declare const agent: (prompt: string, opts?: AgentCallOpts) => Promise<unknown>;

/**
 * Run thunks CONCURRENTLY and await all (a barrier). A thunk that throws resolves
 * to `null` in the result array — the call itself never rejects, so `.filter(Boolean)`.
 */
declare const parallel: <T>(fns: Array<() => Promise<T> | T>) => Promise<T[]>;

/**
 * Run each item through ALL stages independently — NO barrier between stages.
 * Every stage callback receives `(prevResult, originalItem, index)`. A stage that
 * throws drops that item to `null` and skips its remaining stages.
 */
declare const pipeline: (
  items: unknown[],
  ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>
) => Promise<unknown[]>;

/** Start a new progress phase; subsequent `agent()` calls group under it. */
declare function phase(name: string): void;

/** Emit a narrator progress line above the progress tree. */
declare function log(message: string): void;

/** The run's token budget. */
declare const budget: Budget;

/** The value passed as the workflow's `args` input, verbatim (`undefined` if none). */
declare const args: any;
