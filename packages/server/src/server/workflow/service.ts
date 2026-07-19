import { randomUUID } from "node:crypto";
import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  createEngine,
  Journal,
  listWorkflows,
  MockBackend,
  PaseoBackend,
  PaseoHostBackend,
  type PaseoAgentHost,
} from "@getpaseo/agents-workflow";
import {
  WorkflowDefinitionSchema,
  type CreateKanbanWorkflowRuleInput,
  type CreateWorkflowDefinitionInput,
  type DispatchWorkflowRunInput,
  type KanbanWorkflowRule,
  type UpdateKanbanWorkflowRuleInput,
  type UpdateWorkflowDefinitionInput,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@getpaseo/protocol/workflow/types";
import { WORKFLOW_RUN_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { formatWorkflowWorkspaceTitle } from "@getpaseo/protocol/workflow/workspace-title";
import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import type { Logger } from "pino";
import type { WorkflowLogEntry, WorkflowLogLevel } from "@getpaseo/protocol/workflow/types";
import { expandUserPath } from "../path-utils.js";
import { WorkflowEventLog, type WorkflowEventLogWriteInput } from "./event-log.js";
import {
  PROJECT_DEFINITION_ID_PREFIX,
  getProjectDefinition,
  listProjectDefinitions,
} from "./project-definitions.js";
import { WorkflowQueue } from "./queue.js";
import { paginateLogEntries, reconstructRunHistory } from "./run-history.js";
import { WorkflowStore } from "./store.js";

const CREATE_WORKFLOW_SKILL = "paseo-create-workflow";

/** Label stamped on every host agent a workflow run spawns — used to find the run's in-flight agent(s) for cancellation. */
export { WORKFLOW_RUN_ID_LABEL };

const AUTHORING_README = `# Paseo workflows

Author \`*.flow.js\` definitions under \`definitions/\`.

Read \`.claude/skills/${CREATE_WORKFLOW_SKILL}/SKILL.md\` (also mirrored under
\`.agents/skills/\`) before writing a flow. Built-in templates live in the
\`@getpaseo/agents-workflow\` package and can be copied into \`definitions/\`.
`;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the bundled/repo skill dir, or a user-installed copy. */
export async function resolveCreateWorkflowSkillDir(): Promise<string | null> {
  const skillMd = "SKILL.md";
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "skills", CREATE_WORKFLOW_SKILL);
    if (await pathExists(join(candidate, skillMd))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  for (const root of [
    join(homedir(), ".claude", "skills", CREATE_WORKFLOW_SKILL),
    join(homedir(), ".agents", "skills", CREATE_WORKFLOW_SKILL),
    join(homedir(), ".codex", "skills", CREATE_WORKFLOW_SKILL),
  ]) {
    if (await pathExists(join(root, skillMd))) {
      return root;
    }
  }
  return null;
}

async function ensureAuthoringSkill(cwd: string): Promise<void> {
  const source = await resolveCreateWorkflowSkillDir();
  if (!source) {
    return;
  }
  for (const rel of [".claude/skills", ".agents/skills"] as const) {
    const target = join(cwd, rel, CREATE_WORKFLOW_SKILL);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
}

/** Engine may return `{ result: { error } }` while still completing — treat as failed. */
export function extractWorkflowResultError(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const outer = result as Record<string, unknown>;
  const inner = outer.result;
  if (inner && typeof inner === "object" && inner !== null && "error" in inner) {
    const err = (inner as { error: unknown }).error;
    if (typeof err === "string" && err.trim()) {
      return err.trim();
    }
  }
  if (typeof outer.error === "string" && outer.error.trim()) {
    return outer.error.trim();
  }
  return null;
}

/** Annotate script-level errors with the last host/backend agent error. */
export function mergeWorkflowError(
  nestedError: string | null,
  agentErrors: readonly string[],
): string | null {
  let lastAgentError: string | null = null;
  for (let i = agentErrors.length - 1; i >= 0; i--) {
    const item = agentErrors[i]?.trim();
    if (item) {
      lastAgentError = item;
      break;
    }
  }
  if (!nestedError) {
    return lastAgentError;
  }
  if (!lastAgentError || nestedError.includes(lastAgentError)) {
    return nestedError;
  }
  return `${nestedError} — ${lastAgentError}`;
}
function readArgString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readArgBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return undefined;
}

function readArgFeatureValues(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = args.featureValues;
  const featureValues =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  const fast = readArgBoolean(args, "fast");
  if (fast != null) {
    featureValues.fast_mode = fast;
  }
  return Object.keys(featureValues).length > 0 ? featureValues : undefined;
}

export function resolveWorkflowWorkspaceTitle(
  definition: WorkflowDefinition,
  run: WorkflowRun,
): string {
  const body = readArgString(run.args, "workspaceTitle") ?? definition.name;
  return formatWorkflowWorkspaceTitle(body, definition.name);
}

/**
 * Shape of `args` passed into the workflow sandbox.
 *
 * Claude Code builtins read a bare string (`typeof args === "string" ? args : ""`).
 * The app/CLI store `{ task, provider, model }` on the run record for the UI;
 * provider/model are applied to `PaseoBackend` defaults separately. When there is
 * no other structured payload, pass the task string into the engine so those
 * builtins see the CC-native shape. Multi-field dispatches (Kanban, custom
 * objects) keep the full object (plus runtimeDir/key).
 */
export function buildWorkflowEngineArgs(input: {
  args: Record<string, unknown>;
  workspacePath: string;
  runId: string;
}): unknown {
  const merged: Record<string, unknown> = {
    ...input.args,
    runtimeDir: input.workspacePath,
    key: input.runId,
  };
  const task =
    readArgString(merged, "task") ??
    readArgString(merged, "prompt") ??
    readArgString(merged, "title");

  // Keys that are either the task text, already consumed as backend defaults,
  // or host bookkeeping — not a structured script payload on their own.
  const passthroughKeys = new Set([
    "task",
    "prompt",
    "title",
    "provider",
    "model",
    "effort",
    "thinking",
    "mode",
    "fast",
    "featureValues",
    "workspaceTitle",
    "runtimeDir",
    "key",
  ]);
  const hasStructuredPayload = Object.entries(merged).some(([key, value]) => {
    if (passthroughKeys.has(key)) {
      return false;
    }
    if (value == null || value === "") {
      return false;
    }
    return true;
  });

  if (task && !hasStructuredPayload) {
    return task;
  }
  return merged;
}

export function matchesKanbanWorkflowRule(
  rule: KanbanWorkflowRule,
  card: StoredKanbanCard,
  sourceId: string,
): boolean {
  if (!rule.enabled || rule.sourceId !== sourceId) {
    return false;
  }
  const { labelsAny, titleRegex, projectKey } = rule.filter;
  if (labelsAny && !labelsAny.some((label) => card.labels?.includes(label))) {
    return false;
  }
  if (titleRegex && !new RegExp(titleRegex).test(card.title)) {
    return false;
  }
  if (projectKey && card.source.kind === "jira" && card.source.project !== projectKey) {
    return false;
  }
  if (projectKey && card.source.kind !== "jira") {
    return false;
  }
  return true;
}

export type EnsureWorkflowAgentWorkspace = (input: {
  cwd: string;
  runId: string;
  title?: string | null;
}) => Promise<string>;

/**
 * Best-effort interrupt for whatever host agent(s) a running workflow is
 * currently waiting on. Wired by the daemon (AgentManager.cancelAgentRun /
 * archiveAgent over agents labeled with this run's id). The engine itself has
 * no AbortSignal, so this is paired with a run-scoped cancellation flag that
 * short-circuits any *further* agent() calls the script tries to make.
 */
export type CancelWorkflowRunAgents = (input: {
  workspaceId: string;
  runId: string;
}) => Promise<void>;

export interface WorkflowServiceOptions {
  paseoHome: string;
  maxConcurrency?: number;
  runner?: (definition: WorkflowDefinition, run: WorkflowRun) => Promise<unknown>;
  /**
   * Mint (or resolve) ONE Paseo workspace for a run's agent `cwd`. Wired by the
   * daemon so every agent in the run shares one workspace instead of minting
   * a twin per attempt.
   */
  ensureAgentWorkspace?: EnsureWorkflowAgentWorkspace;
  /**
   * Protocol/host seam for running agents in-daemon (createAgent + AgentManager).
   * Preferred over shelling out to a PATH `paseo` CLI.
   */
  agentHost?: PaseoAgentHost;
  /** See `CancelWorkflowRunAgents`. */
  cancelWorkflowAgents?: CancelWorkflowRunAgents;
  logger?: Logger;
}

export class WorkflowService {
  private readonly store: WorkflowStore;
  private readonly eventLog: WorkflowEventLog;
  private readonly queue: WorkflowQueue;
  private readonly paseoHome: string;
  private readonly customRunner:
    | ((definition: WorkflowDefinition, run: WorkflowRun) => Promise<unknown>)
    | null;
  private readonly logger: Logger | null;
  private ensureAgentWorkspace: EnsureWorkflowAgentWorkspace | undefined;
  private agentHost: PaseoAgentHost | undefined;
  private cancelWorkflowAgents: CancelWorkflowRunAgents | undefined;
  /**
   * Runs that received a cancel request while already `running`. The engine
   * has no abort signal, so this in-memory flag is the short-circuit: the
   * host wrapper refuses any further agent() call for the run, and execute()
   * forces the terminal status to "cancelled" once the script settles.
   * Per-daemon-lifetime only — a restart mid-run already orphans the run.
   */
  private readonly cancelledRunIds = new Set<string>();

  constructor(options: WorkflowServiceOptions) {
    this.paseoHome = options.paseoHome;
    const workflowsDir = join(options.paseoHome, "workflows");
    this.store = new WorkflowStore(workflowsDir);
    this.eventLog = new WorkflowEventLog(workflowsDir);
    this.queue = new WorkflowQueue({ maxConcurrency: options.maxConcurrency });
    this.customRunner = options.runner ?? null;
    this.ensureAgentWorkspace = options.ensureAgentWorkspace;
    this.agentHost = options.agentHost;
    this.cancelWorkflowAgents = options.cancelWorkflowAgents;
    this.logger = options.logger?.child({ module: "workflow-service" }) ?? null;
  }

  private async log(input: WorkflowEventLogWriteInput): Promise<void> {
    try {
      await this.eventLog.append(input);
    } catch (err) {
      this.logger?.warn({ err, event: input.event }, "workflow event log append failed");
    }
  }

  /**
   * Late-bind workspace minting after registries are ready (bootstrap creates
   * WorkflowService before project/workspace stores exist).
   */
  setEnsureAgentWorkspace(ensure: EnsureWorkflowAgentWorkspace): void {
    this.ensureAgentWorkspace = ensure;
  }

  /** Late-bind the in-daemon PaseoAgentHost after AgentManager is ready. */
  setAgentHost(host: PaseoAgentHost): void {
    this.agentHost = host;
  }

  /** Late-bind the in-flight-agent interrupt seam (see `CancelWorkflowRunAgents`). */
  setCancelWorkflowAgents(cancel: CancelWorkflowRunAgents): void {
    this.cancelWorkflowAgents = cancel;
  }

  async listDefinitions(cwd?: string): Promise<WorkflowDefinition[]> {
    const stored = await this.store.listDefinitions();
    if (!cwd) {
      return stored;
    }
    // Read-through project definitions (.paseo/workflows + .claude/workflows
    // under cwd) — listed per-request, never imported into the store.
    const project = await listProjectDefinitions(expandUserPath(cwd));
    return [...stored, ...project];
  }

  async listBuiltins(): Promise<WorkflowDefinition[]> {
    const now = new Date().toISOString();
    return listWorkflows()
      .filter((workflow) => workflow.origin === "builtin")
      .map((workflow) =>
        WorkflowDefinitionSchema.parse({
          id: `builtin:${workflow.name}`,
          name: workflow.name,
          description:
            typeof workflow.meta.description === "string" ? workflow.meta.description : null,
          source: workflow.source,
          builtin: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
  }

  /** Ensure `$PASEO_HOME/workflows` exists for agent-authored `*.flow.js` definitions. */
  async prepareAuthoring(): Promise<{ cwd: string }> {
    const cwd = join(this.paseoHome, "workflows");
    await mkdir(join(cwd, "definitions"), { recursive: true });
    await ensureAuthoringSkill(cwd);
    const readmePath = join(cwd, "README.md");
    await writeFile(readmePath, AUTHORING_README, "utf8");
    return { cwd };
  }

  async getDefinition(id: string): Promise<WorkflowDefinition | null> {
    const stored = await this.store.getDefinition(id);
    if (stored) {
      return stored;
    }
    // Project definitions resolve by reading the repo file fresh, so a
    // dispatch always runs the current on-disk source.
    if (id.startsWith(PROJECT_DEFINITION_ID_PREFIX)) {
      return getProjectDefinition(id);
    }
    // Builtins are templates that can also be dispatched directly (id = builtin:<name>).
    if (!id.startsWith("builtin:")) {
      return null;
    }
    const builtins = await this.listBuiltins();
    return builtins.find((definition) => definition.id === id) ?? null;
  }

  async createDefinition(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition> {
    const definition = await this.store.createDefinition(input);
    await this.log({
      event: "definition.create",
      message: `created ${definition.name}`,
      definitionId: definition.id,
      data: { name: definition.name },
    });
    return definition;
  }

  async updateDefinition(input: UpdateWorkflowDefinitionInput): Promise<WorkflowDefinition | null> {
    const definition = await this.store.updateDefinition(input);
    if (definition) {
      await this.log({
        event: "definition.update",
        message: `updated ${definition.name}`,
        definitionId: definition.id,
      });
    }
    return definition;
  }

  async deleteDefinition(id: string): Promise<boolean> {
    const ok = await this.store.deleteDefinition(id);
    if (ok) {
      await this.log({
        event: "definition.delete",
        message: `deleted ${id}`,
        definitionId: id,
      });
    }
    return ok;
  }

  async listRunLogs(
    runId: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<{ entries: WorkflowLogEntry[]; nextSeq: number; hasMore: boolean }> {
    // Prefer the append-only events.jsonl when the daemon wrote one.
    if (await this.eventLog.hasRunLogs(runId)) {
      return this.eventLog.readRunLogs(runId, options);
    }
    // Historical runs (or a daemon that never emitted events): rebuild a timeline
    // from the run record + engine journal so the detail sheet is never empty.
    const run = await this.store.getRun(runId);
    if (!run) {
      return { entries: [], nextSeq: options.afterSeq ?? 0, hasMore: false };
    }
    const history = await reconstructRunHistory(run);
    return paginateLogEntries(history, options);
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return this.store.listRuns();
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    return this.store.getRun(id);
  }

  /**
   * Recover run state after a daemon restart. Call once at bootstrap, after
   * `ensureAgentWorkspace`/`agentHost`/`cancelWorkflowAgents` are wired so a
   * re-enqueued run can actually execute:
   * - `queued` runs are re-enqueued (their in-memory queue slot was lost).
   * - `running` runs are stale — the process that was executing them is gone
   *   — so they're marked `failed` with an interruption error, same as
   *   `LoopService.initialize()` does for `loops.json`.
   */
  async recoverAfterRestart(): Promise<void> {
    // listRuns is newest-first (UI order) — re-enqueue oldest-first so the
    // restored queue keeps the original FIFO dispatch order.
    const runs = (await this.store.listRuns())
      .slice()
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
    for (const run of runs) {
      if (run.status === "running") {
        await this.store.updateRun(run.id, (current) =>
          current.status === "running"
            ? {
                ...current,
                status: "failed",
                endedAt: new Date().toISOString(),
                error: "Interrupted by daemon restart",
              }
            : current,
        );
        await this.log({
          level: "warn",
          event: "run.interrupted",
          message: "run was interrupted by daemon restart",
          runId: run.id,
          definitionId: run.definitionId,
        });
        continue;
      }
      if (run.status !== "queued") {
        continue;
      }
      const definition = await this.getDefinition(run.definitionId);
      if (!definition) {
        await this.store.updateRun(run.id, (current) =>
          current.status === "queued"
            ? {
                ...current,
                status: "failed",
                endedAt: new Date().toISOString(),
                error: `Workflow definition not found: ${run.definitionId}`,
              }
            : current,
        );
        continue;
      }
      await this.log({
        event: "run.requeued",
        message: "re-queued after daemon restart",
        runId: run.id,
        definitionId: run.definitionId,
      });
      void this.queue.enqueue(() => this.execute(definition, run));
    }
  }

  async dispatch(input: DispatchWorkflowRunInput): Promise<WorkflowRun> {
    const definition = await this.getDefinition(input.definitionId);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${input.definitionId}`);
    }
    const id = `wfr_${randomUUID()}`;
    const runDir = join(this.paseoHome, "workflows", "runs", id);
    await mkdir(runDir, { recursive: true });
    const workspaceTitle = formatWorkflowWorkspaceTitle(
      input.workspaceTitle?.trim() || definition.name,
      definition.name,
    );
    const args: Record<string, unknown> = {
      ...input.args,
      workspaceTitle,
    };
    const run: WorkflowRun = {
      id,
      definitionId: definition.id,
      status: "queued",
      args,
      cwd: input.cwd ? expandUserPath(input.cwd) : runDir,
      workspaceId: null,
      workspacePath: runDir,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
    };
    await this.store.createRun(run);
    await this.log({
      event: "run.queued",
      message: `queued ${definition.name}`,
      runId: run.id,
      definitionId: definition.id,
      data: {
        cwd: run.cwd,
        provider: readArgString(run.args, "provider") ?? null,
        model: readArgString(run.args, "model") ?? null,
      },
    });
    void this.queue.enqueue(() => this.execute(definition, run));
    return run;
  }

  /**
   * Cancel a run. `queued` runs are marked cancelled immediately (the queue's
   * `execute()` guard skips them when their slot comes up). `running` runs
   * can't be aborted mid-engine (no AbortSignal in `@getpaseo/agents-workflow`),
   * so this: (1) flags the run so the host wrapper refuses further agent()
   * calls, (2) best-effort interrupts whatever host agent is currently in
   * flight via `cancelWorkflowAgents`, and (3) leaves the terminal status
   * write to `execute()` once the (now agent()-starved) script actually
   * settles — see the `cancelledRunIds` field doc.
   */
  async cancel(id: string): Promise<WorkflowRun | null> {
    const afterQueuedAttempt = await this.store.updateRun(id, (run) => {
      if (run.status !== "queued") {
        return run;
      }
      return { ...run, status: "cancelled", endedAt: new Date().toISOString() };
    });
    if (!afterQueuedAttempt) {
      return null;
    }
    if (afterQueuedAttempt.status === "cancelled") {
      await this.log({
        event: "run.cancelled",
        message: "cancelled while queued",
        runId: id,
        definitionId: afterQueuedAttempt.definitionId,
      });
      return afterQueuedAttempt;
    }
    if (afterQueuedAttempt.status === "running") {
      this.cancelledRunIds.add(id);
      await this.log({
        event: "run.cancel_requested",
        message: "cancellation requested while running",
        runId: id,
        definitionId: afterQueuedAttempt.definitionId,
      });
      if (afterQueuedAttempt.workspaceId && this.cancelWorkflowAgents) {
        try {
          await this.cancelWorkflowAgents({
            workspaceId: afterQueuedAttempt.workspaceId,
            runId: id,
          });
        } catch (err) {
          this.logger?.warn(
            { err, runId: id },
            "workflow cancel: failed to interrupt in-flight agent",
          );
        }
      }
      return (await this.store.getRun(id)) ?? afterQueuedAttempt;
    }
    return afterQueuedAttempt;
  }

  async listRules(): Promise<KanbanWorkflowRule[]> {
    return this.store.listRules();
  }

  async createRule(input: CreateKanbanWorkflowRuleInput): Promise<KanbanWorkflowRule> {
    return this.store.createRule(input);
  }

  async updateRule(input: UpdateKanbanWorkflowRuleInput): Promise<KanbanWorkflowRule | null> {
    return this.store.updateRule(input);
  }

  async deleteRule(id: string): Promise<boolean> {
    return this.store.deleteRule(id);
  }

  async enqueueForNewKanbanCard(
    card: StoredKanbanCard,
    sourceId: string,
    cwd?: string,
  ): Promise<void> {
    const rules = await this.store.listRules();
    for (const rule of rules) {
      if (!matchesKanbanWorkflowRule(rule, card, sourceId)) {
        continue;
      }
      await this.dispatch({
        definitionId: rule.workflowDefinitionId,
        cwd,
        args: {
          cardId: card.id,
          title: card.title,
          url: card.url,
          externalId: card.externalId,
          labels: card.labels ?? [],
          metadata: card.metadata ?? {},
        },
      });
    }
  }

  private async execute(definition: WorkflowDefinition, initial: WorkflowRun): Promise<void> {
    const run = await this.store.updateRun(initial.id, (current) => {
      if (current.status === "cancelled") {
        return current;
      }
      return { ...current, status: "running", startedAt: new Date().toISOString() };
    });
    if (!run || run.status === "cancelled") {
      return;
    }
    await this.log({
      event: "run.start",
      message: `start ${definition.name} via ${this.describeBackend()}`,
      runId: run.id,
      definitionId: definition.id,
      data: {
        cwd: run.cwd,
        provider: readArgString(run.args, "provider") ?? null,
        model: readArgString(run.args, "model") ?? null,
        backend: this.describeBackend(),
      },
    });
    try {
      const { result, agentErrors } = await this.runnerWithAgentErrors(definition, run);
      const cancelled = this.cancelledRunIds.has(run.id);
      const nestedError = extractWorkflowResultError(result);
      const error = mergeWorkflowError(nestedError, agentErrors);
      let status: WorkflowRun["status"];
      let level: WorkflowLogLevel;
      let event: string;
      let message: string;
      if (cancelled) {
        status = "cancelled";
        level = "warn";
        event = "run.cancelled";
        message = "cancelled while running";
      } else if (error) {
        status = "failed";
        level = "error";
        event = "run.failed";
        message = error;
      } else {
        status = "succeeded";
        level = "info";
        event = "run.succeeded";
        message = "succeeded";
      }
      await this.store.updateRun(run.id, (current) => ({
        ...current,
        status,
        endedAt: new Date().toISOString(),
        result,
        error: cancelled ? (error ?? "cancelled") : error,
      }));
      await this.log({
        level,
        event,
        message,
        runId: run.id,
        definitionId: definition.id,
        data: { workspaceId: run.workspaceId, agentErrors },
      });
    } catch (error) {
      const cancelled = this.cancelledRunIds.has(run.id);
      const message = error instanceof Error ? error.message : String(error);
      await this.log({
        level: cancelled ? "warn" : "error",
        event: cancelled ? "run.cancelled" : "run.crashed",
        message: cancelled ? "cancelled while running" : message,
        runId: run.id,
        definitionId: definition.id,
      });
      await this.store.updateRun(run.id, (current) => ({
        ...current,
        status: cancelled ? "cancelled" : "failed",
        endedAt: new Date().toISOString(),
        error: cancelled ? "cancelled while running" : message,
      }));
    } finally {
      this.cancelledRunIds.delete(run.id);
    }
  }

  private describeBackend(): string {
    if (process.env.PASEO_WORKFLOW_BACKEND === "mock") return "mock";
    if (this.agentHost) return "paseo-host";
    return "paseo-cli";
  }

  private async runnerWithAgentErrors(
    definition: WorkflowDefinition,
    run: WorkflowRun,
  ): Promise<{ result: unknown; agentErrors: string[] }> {
    if (this.customRunner) {
      return { result: await this.customRunner(definition, run), agentErrors: [] };
    }
    return this.runEngine(definition, run);
  }

  private async runEngine(
    definition: WorkflowDefinition,
    run: WorkflowRun,
  ): Promise<{ result: unknown; agentErrors: string[] }> {
    const provider = readArgString(run.args, "provider");
    const model = readArgString(run.args, "model");
    const effort = readArgString(run.args, "effort") ?? readArgString(run.args, "thinking");
    const mode = readArgString(run.args, "mode");
    const featureValues = readArgFeatureValues(run.args);
    const workspaceId = await this.resolveRunAgentWorkspace(definition, run);
    const agentErrors: string[] = [];

    if (!workspaceId && process.env.PASEO_WORKFLOW_BACKEND !== "mock" && this.agentHost) {
      throw new Error(
        "workflow agent workspace missing — ensureAgentWorkspace was not wired or failed",
      );
    }

    await this.log({
      event: "run.backend",
      message: `${this.describeBackend()} provider=${provider ?? "-"} model=${model ?? "-"} effort=${effort ?? "-"} mode=${mode ?? "-"}`,
      runId: run.id,
      definitionId: definition.id,
      data: { workspaceId, cwd: run.cwd, featureValues: featureValues ?? null },
    });

    const backendOptions = {
      cwd: run.cwd,
      ...(workspaceId ? { workspaceId } : {}),
      ...(provider ? { defaultProvider: provider } : {}),
      ...(model ? { defaultModel: model } : {}),
      ...(effort ? { defaultEffort: effort } : {}),
      ...(mode ? { defaultMode: mode } : {}),
      ...(featureValues ? { defaultFeatureValues: featureValues } : {}),
    };
    let backend;
    if (process.env.PASEO_WORKFLOW_BACKEND === "mock") {
      backend = new MockBackend();
    } else if (this.agentHost) {
      backend = new PaseoHostBackend({
        host: this.wrapHostWithRunLogs(this.agentHost, run, definition.id),
        ...backendOptions,
      });
    } else {
      backend = new PaseoBackend(backendOptions);
    }

    const journal = new Journal({ path: join(run.workspacePath, "journal.jsonl") });
    // Every engine event lands in the run's event log so clients can rebuild
    // the live progress tree (phases → agent calls) purely from log entries.
    // callId is the engine's monotonic per-agent() id — the stable node key.
    const agentEventData = (event: {
      id: number;
      label?: string;
      phase?: string;
      model?: string;
      cached?: boolean;
    }) => ({
      callId: event.id,
      label: event.label ?? null,
      phase: event.phase ?? null,
      model: event.model ?? null,
      cached: event.cached ?? false,
    });
    const engine = createEngine({
      backend,
      journal,
      onPhase: (phase) => {
        void this.log({
          level: "info",
          event: "phase",
          message: phase,
          runId: run.id,
          definitionId: definition.id,
        });
      },
      onLog: (message) => {
        void this.log({
          level: "info",
          event: "log",
          message,
          runId: run.id,
          definitionId: definition.id,
        });
      },
      onAgentEvent: (event) => {
        if (event.type === "error" && event.error) {
          agentErrors.push(event.error);
          void this.log({
            level: "error",
            event: "agent.error",
            message: event.error,
            runId: run.id,
            definitionId: definition.id,
            data: agentEventData(event),
          });
        } else if (event.type === "retry" && event.error) {
          void this.log({
            level: "warn",
            event: "agent.retry",
            message: event.error,
            runId: run.id,
            definitionId: definition.id,
            data: { ...agentEventData(event), attempt: event.attempt ?? null },
          });
        } else if (event.type === "start" || event.type === "complete") {
          // debug level keeps the raw log readable (the host wrapper already
          // logs agent.started/agent.done at info); the progress tree still
          // consumes these entries regardless of level.
          void this.log({
            level: "debug",
            event: `agent.${event.type}`,
            message: event.label ?? `agent #${event.id}`,
            runId: run.id,
            definitionId: definition.id,
            data: {
              ...agentEventData(event),
              ...(event.usage?.outputTokens != null
                ? { outputTokens: event.usage.outputTokens }
                : {}),
            },
          });
        }
      },
    });
    try {
      const result = await engine.run(definition.source, {
        args: buildWorkflowEngineArgs({
          args: run.args,
          workspacePath: run.workspacePath,
          runId: run.id,
        }),
      });
      return { result, agentErrors };
    } finally {
      await engine.dispose();
    }
  }

  /**
   * One Paseo workspace per workflow run for all `agent()` / structured retries.
   * Persists `run.workspaceId` so the UI and cancel paths can see it.
   */
  private async resolveRunAgentWorkspace(
    definition: WorkflowDefinition,
    run: WorkflowRun,
  ): Promise<string | null> {
    if (run.workspaceId) {
      return run.workspaceId;
    }
    if (!this.ensureAgentWorkspace) {
      return null;
    }
    const workspaceId = await this.ensureAgentWorkspace({
      cwd: run.cwd,
      runId: run.id,
      title: resolveWorkflowWorkspaceTitle(definition, run),
    });
    const updated = await this.store.updateRun(run.id, (current) => ({
      ...current,
      workspaceId,
    }));
    if (updated) {
      run.workspaceId = workspaceId;
    }
    await this.log({
      event: "run.workspace",
      message: `workspace ${workspaceId}`,
      runId: run.id,
      definitionId: definition.id,
      data: { workspaceId, cwd: run.cwd },
    });
    return workspaceId;
  }

  /** Log each host agent attempt into the dedicated workflow event stream. */
  private wrapHostWithRunLogs(
    host: PaseoAgentHost,
    run: WorkflowRun,
    definitionId: string,
  ): PaseoAgentHost {
    return {
      runAgent: async (request) => {
        if (this.cancelledRunIds.has(run.id)) {
          // Cancel was requested while running — refuse any FURTHER agent()
          // the script tries to start (the already in-flight one, if any, is
          // interrupted separately via `cancelWorkflowAgents`).
          await this.log({
            level: "warn",
            event: "agent.skipped",
            message: "run cancelled — skipping agent() call",
            runId: run.id,
            definitionId,
          });
          return { error: "workflow run cancelled" };
        }
        await this.log({
          event: "agent.start",
          message:
            `${request.provider}${request.model ? `/${request.model}` : ""} ${request.title ?? ""}`.trim(),
          runId: run.id,
          definitionId,
          data: {
            provider: request.provider,
            model: request.model ?? null,
            workspaceId: request.workspaceId ?? null,
            isolation: request.isolation ?? null,
          },
        });
        const result = await host.runAgent({
          ...request,
          labels: {
            ...request.labels,
            [WORKFLOW_RUN_ID_LABEL]: run.id,
          },
        });
        await this.log({
          level: result.error ? "error" : "info",
          event: result.error ? "agent.failed" : "agent.done",
          message: result.error ?? `ok ${result.text?.length ?? 0}c`,
          runId: run.id,
          definitionId,
          data: { agentId: result.agentId ?? null },
        });
        return result;
      },
    };
  }
}
