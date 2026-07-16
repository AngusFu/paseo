/**
 * AgentBackend — the ONLY contract the core engine depends on.
 *
 * The engine orchestrates deterministic workflow scripts. Whenever a script
 * calls `agent(prompt, opts)`, the engine hands a normalized `AgentSpec` to a
 * backend and awaits an `AgentResult`. The engine knows nothing about HOW a
 * backend runs an agent: a local subprocess, a remote daemon, an LLM API, or a
 * test double are all interchangeable.
 *
 * Design rules:
 *  - Interface-first. Backends are pluggable implementations of this class.
 *  - The core never imports a concrete backend. Paseo, Mock, etc. live under
 *    src/backends/ and are injected by the caller.
 *  - Structured output is NOT a backend responsibility. The engine owns the
 *    structured contract (prompt instructs JSON + engine-side validate + retry)
 *    so it works uniformly on every backend, including "dumb" ones.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Normalized, backend-agnostic description of one agent run. */
export interface AgentSpec {
  /** Fully-assembled prompt (persona + task) to run. */
  prompt: string;
  /** Human/UI label for the agent. */
  label?: string;
  /** Workflow phase this agent belongs to. */
  phase?: string;
  /** Model id (backend-interpreted). */
  model?: string;
  /**
   * Reasoning effort / thinking option id (backend-interpreted).
   * On Paseo this maps to `thinkingOptionId` / `paseo run --thinking`.
   */
  effort?: Effort | string;
  /**
   * Provider mode id (backend-interpreted).
   * On Paseo this maps to `modeId` / `paseo run --mode`.
   */
  mode?: string;
  /**
   * Provider feature values (backend-interpreted).
   * On Paseo this maps to createAgent `features` / session `featureValues`
   * (e.g. `{ fast_mode: true }`).
   */
  featureValues?: Record<string, unknown>;
  /** Provider id (backend-interpreted; the superset's multi-provider field). */
  provider?: string;
  /** e.g. 'worktree'. */
  isolation?: string;
  /** Extra key/value labels. */
  labels?: Record<string, string>;
}

/** Optional usage accounting for budgets. */
export interface AgentUsage {
  outputTokens?: number;
}

/** Result of one agent run. Resolve with { error } on ordinary failure. */
export interface AgentResult {
  /** The agent's final text (its return value). */
  text?: string;
  /** Set when the run failed; the engine maps this to null. */
  error?: string;
  usage?: AgentUsage;
}

export abstract class AgentBackend {
  /** Stable identifier for this backend (e.g. 'mock', 'paseo'). */
  abstract get name(): string;

  /**
   * Run one agent to completion and return its result.
   * Must RESOLVE (not reject) with { error } for ordinary agent failures so the
   * engine can apply its "agent() returns null" semantics uniformly.
   */
  abstract run(spec: AgentSpec): Promise<AgentResult>;

  /**
   * Optional lifecycle hook. Called once when the engine is torn down.
   * Backends that hold sockets/processes override this.
   */
  async dispose(): Promise<void> {}
}
