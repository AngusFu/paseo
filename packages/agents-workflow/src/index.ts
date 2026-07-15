// Public SDK surface for agents-workflow. CURATED — engine INTERNALS (the node:vm
// sandbox, the schema seam, the journal-key hash, prompt-library persona assembly,
// the concurrency helper, the cap constants) are intentionally NOT re-exported here.
// If you genuinely need one, import it from its source module (`./sandbox.js`,
// `./schema-normalize.js`, …) — it is not part of the stable SDK.

// ── engine ───────────────────────────────────────────────────────────────────
export { createEngine, extractMeta } from "./engine.js";
export type {
  Engine,
  EngineConfig,
  RunResult,
  EngineStats,
  LoadedWorkflow,
  WorkflowMeta,
  AgentCallOpts,
  AgentEvent,
  Budget,
} from "./engine.js";

// ── backends (implement AgentBackend, or use a shipped one) ───────────────────
export { AgentBackend } from "./backend.js";
export type { AgentSpec, AgentResult, AgentUsage, Effort } from "./backend.js";
/** the type `AgentCallOpts.schema` accepts (inline JSON Schema object OR a zod schema). */
export type { SchemaInput } from "./schema-normalize.js";
export { MockBackend } from "./backends/mock.js";
export type { MockBackendConfig, MockResponder, MockReply } from "./backends/mock.js";
export { PaseoBackend } from "./backends/paseo.js";
export type { PaseoBackendOptions, PaseoExec } from "./backends/paseo.js";

// ── live progress data model (headless UI) ────────────────────────────────────
export { createProgressModel } from "./progress-model.js";
export type {
  ProgressModel,
  WorkflowSnapshot,
  PhaseView,
  AgentView,
  AgentStatus,
  PhaseStatus,
} from "./progress-model.js";

// ── resume (pass a Journal to EngineConfig.journal) ───────────────────────────
export { Journal } from "./journal.js";
export type { JournalOptions } from "./journal.js";

// ── flow discovery + static validation ────────────────────────────────────────
export { resolveWorkflow, listWorkflows } from "./registry.js";
export type { ResolvedWorkflow, RegistryDirs } from "./registry.js";
export { validateScript } from "./validator.js";
export type { Violation, ValidateResult } from "./validator.js";

// ── errors (`catch (e) { if (e instanceof WorkflowError) … }`) ────────────────
export { WorkflowError } from "./errors.js";
export { WorkflowAgentCapError, WorkflowBudgetExceededError } from "./prompt-library.js";
