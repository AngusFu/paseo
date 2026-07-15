/**
 * Prompt library — reusable prompts lifted from Claude Code's Workflow tool
 * (v2.1.207, deobfuscated). These are backend-agnostic TEXT. They are reused
 * verbatim as the persona prepended to every agent prompt.
 *
 * Important: the structured-output CONTRACT (D0y/L0y below) references a
 * provider-side "StructuredOutput" tool. Our backends (mock, paseo-via-cli,
 * arbitrary LLMs) do NOT expose that tool, so the ENGINE enforces structure
 * itself via `structuredPersona()` (raw-JSON instruction + engine-side
 * validate + retry). The canonical prompts are kept here for fidelity and for
 * any future backend that does have a native structured-output tool.
 */
import { WorkflowError } from "./errors.js";

/** I0y — default subagent persona (verbatim text return). */
export const SUBAGENT_TEXT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.`;

/** R0y — appended for a custom agentType persona without a schema. */
export const AGENTTYPE_NOTE = `

---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.`;

/** D0y — canonical structured-output persona (provider tool variant, kept for fidelity). */
export const SUBAGENT_STRUCTURED_TOOL = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the StructuredOutput tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call StructuredOutput with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the StructuredOutput tool call.
- If the schema validation fails, read the error and call StructuredOutput again with a corrected shape.
- After calling StructuredOutput successfully, end your turn. No acknowledgment needed.`;

/** L0y — canonical structured-output note appended to a custom agentType persona. */
export const AGENTTYPE_STRUCTURED_NOTE = `

---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the StructuredOutput tool exactly once — the tool's input schema defines the required shape. Do your work, then call StructuredOutput; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call StructuredOutput again with a corrected shape.`;

/**
 * Portable structured persona — the reused structured-output concept expressed
 * so it works on ANY backend (no StructuredOutput tool required). The engine
 * validates the returned text against `schema` and retries on failure.
 */
export function structuredPersona(schema: unknown): string {
  return (
    "You are a subagent spawned by a workflow orchestration script. Complete the task, " +
    "then respond with ONLY a raw JSON value that validates against the JSON Schema below — " +
    "no prose, no code fences, no markdown. The script parses your entire response as JSON.\n\n" +
    "JSON Schema:\n" +
    JSON.stringify(schema)
  );
}

export function structuredRetrySuffix(reason: string): string {
  return `\n\nYour previous response was rejected: ${reason}. Respond again with ONLY valid JSON matching the schema.`;
}

/** k0y — agent() call cap reached. */
export const AGENT_CAP_MESSAGE =
  "Workflow agent() call cap reached (1000). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.";

/** wAd — token budget exceeded. */
export function budgetExceededMessage(spent: number, total: number): string {
  return `Workflow token budget exceeded (${spent} / ${total} output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.`;
}

/** S0y / v0y — determinism guards. */
export const DATE_BAN_MESSAGE =
  "Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.";
export const RANDOM_BAN_MESSAGE =
  "Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.";

/** Thrown when the per-run agent() call cap is exceeded. */
export class WorkflowAgentCapError extends WorkflowError {
  constructor() {
    super(AGENT_CAP_MESSAGE);
    this.name = "WorkflowAgentCapError";
  }
}

/** Thrown when the token budget is exhausted; in-flight agents still complete. */
export class WorkflowBudgetExceededError extends WorkflowError {
  readonly spent: number;
  readonly total: number;
  constructor(spent: number, total: number) {
    super(budgetExceededMessage(spent, total));
    this.name = "WorkflowBudgetExceededError";
    this.spent = spent;
    this.total = total;
  }
}
