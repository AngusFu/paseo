import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { curateAgentActivity } from "./agent/activity-curator.js";
import type { AgentManager } from "./agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "./agent/agent-prompt.js";
import { generateStructuredAgentResponseWithFallback } from "./agent/agent-response-loop.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import { resolveStructuredGenerationProviders } from "./agent/structured-generation-providers.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { formatGoalContinuationPrompt } from "./goal/continuation-prompt.js";
import { formatGoalEvaluationFailurePrompt } from "./goal/evaluation-failure-prompt.js";

export type GoalEvaluator = (input: {
  agentId: string;
  condition: string;
}) => Promise<z.infer<typeof GoalEvaluationSchema>>;

const DEFAULT_MAX_ITERATIONS = 12;
const GOAL_ACTIVITY_MAX_ITEMS = 80;

const GoalEvaluationSchema = z.object({
  met: z.boolean(),
  reason: z.string().min(1),
});

const GoalStatusSchema = z.enum(["active", "paused", "met", "cleared", "max_iterations"]);

const GoalPauseReasonSchema = z.enum(["permissions", "evaluation_failed"]);

export const GoalActiveRecordSchema = z.object({
  agentId: z.string(),
  condition: z.string().min(1),
  status: GoalStatusSchema,
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastEvaluationReason: z.string().nullable().optional(),
  pauseReason: GoalPauseReasonSchema.optional(),
});

const StoredActiveGoalsSchema = z.record(z.string(), GoalActiveRecordSchema);

export type GoalActiveRecord = z.infer<typeof GoalActiveRecordSchema>;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

type GoalAgentManager = Pick<
  AgentManager,
  "getAgent" | "getTimeline" | "getPendingPermissions" | "streamAgent"
>;

function nowIso(): string {
  return new Date().toISOString();
}

function cloneRecord(record: GoalActiveRecord): GoalActiveRecord {
  return GoalActiveRecordSchema.parse(record);
}

function buildEvaluationPrompt(condition: string, activity: string): string {
  return [
    "Evaluate whether the coding agent has satisfied the goal condition.",
    "Use only the activity transcript — do not assume unstated work.",
    "The condition must be verifiable from commands run, files changed, or explicit evidence in the transcript.",
    "",
    "Goal condition:",
    condition.trim(),
    "",
    "Agent activity:",
    activity.trim() || "(no activity yet)",
    "",
    'Respond with JSON: { "met": boolean, "reason": string }',
    "Set met=true only when the condition clearly holds with cited evidence.",
    "Set met=false when more work is needed or evidence is insufficient.",
  ].join("\n");
}

export class GoalService {
  private readonly storePath: string;
  private readonly logger: Logger;
  private loaded = false;
  private readonly goals = new Map<string, GoalActiveRecord>();
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly pendingContinuations = new Map<
    string,
    { timer: ReturnType<typeof setTimeout> | null }
  >();

  constructor(
    private readonly options: {
      paseoHome: string;
      agentManager: GoalAgentManager;
      providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
      readDaemonConfig: () => StructuredGenerationDaemonConfig;
      logger: Logger;
      evaluateGoal?: GoalEvaluator;
    },
  ) {
    this.storePath = path.join(options.paseoHome, "goals", "active.json");
    this.logger = options.logger.child({ module: "goal-service" });
  }

  async initialize(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.goals.clear();
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = StoredActiveGoalsSchema.parse(JSON.parse(raw));
      for (const [agentId, record] of Object.entries(parsed)) {
        if (
          record.status === "active" ||
          record.status === "paused" ||
          record.status === "met" ||
          record.status === "max_iterations"
        ) {
          this.goals.set(agentId, cloneRecord(record));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error }, "goal-service: failed to load active goals");
      }
    }
    this.loaded = true;
  }

  hasActiveGoal(agentId: string): boolean {
    const record = this.goals.get(agentId);
    return record?.status === "active" || record?.status === "paused";
  }

  getGoal(agentId: string): GoalActiveRecord | null {
    const record = this.goals.get(agentId);
    return record ? cloneRecord(record) : null;
  }

  async setGoal(
    agentId: string,
    input: { condition: string; maxIterations?: number },
  ): Promise<GoalActiveRecord> {
    const condition = input.condition.trim();
    if (!condition) {
      throw new Error("condition cannot be empty");
    }
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
      throw new Error("maxIterations must be a positive integer");
    }
    const now = nowIso();
    const existing = this.goals.get(agentId);
    const preserveIteration = existing?.status === "active" || existing?.status === "paused";
    const record: GoalActiveRecord = {
      agentId,
      condition,
      status: "active",
      iteration: preserveIteration ? existing.iteration : 0,
      maxIterations,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastEvaluationReason: null,
      pauseReason: undefined,
    };
    this.goals.set(agentId, record);
    await this.persist();
    this.logger.info({ agentId, maxIterations }, "goal-service: goal set");
    return cloneRecord(record);
  }

  async clearGoal(agentId: string): Promise<GoalActiveRecord | null> {
    const existing = this.goals.get(agentId);
    if (!existing) {
      return null;
    }
    this.clearPendingContinuation(agentId);
    const cleared: GoalActiveRecord = {
      ...existing,
      status: "cleared",
      updatedAt: nowIso(),
    };
    this.goals.delete(agentId);
    await this.persist();
    this.logger.info({ agentId }, "goal-service: goal cleared");
    return cloneRecord(cleared);
  }

  async maybeScheduleContinuation(agentId: string): Promise<void> {
    this.clearPendingContinuation(agentId);
    const record = this.goals.get(agentId);
    if (!record || (record.status !== "active" && record.status !== "paused")) {
      return;
    }

    if (record.status === "paused" && record.pauseReason === "evaluation_failed") {
      return;
    }

    const pendingPermissions = this.options.agentManager.getPendingPermissions(agentId);
    if (pendingPermissions.length > 0) {
      if (record.status !== "paused") {
        record.status = "paused";
        record.pauseReason = "permissions";
        record.updatedAt = nowIso();
        await this.persist();
        this.logger.info({ agentId }, "goal-service: paused for pending permissions");
      }
      return;
    }

    if (record.status === "paused") {
      record.status = "active";
      record.pauseReason = undefined;
      record.updatedAt = nowIso();
      await this.persist();
    }

    const nextIteration = record.iteration + 1;
    if (nextIteration > record.maxIterations) {
      record.status = "max_iterations";
      record.iteration = record.maxIterations;
      record.updatedAt = nowIso();
      record.lastEvaluationReason = `Reached max iterations (${record.maxIterations}).`;
      record.pauseReason = undefined;
      await this.persist();
      this.logger.info(
        { agentId, maxIterations: record.maxIterations },
        "goal-service: max iterations",
      );
      return;
    }

    let evaluation: z.infer<typeof GoalEvaluationSchema>;
    try {
      evaluation = await this.runEvaluation(agentId, record.condition);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, agentId }, "goal-service: evaluation failed");
      record.status = "paused";
      record.pauseReason = "evaluation_failed";
      record.lastEvaluationReason = `Evaluation failed: ${message}`;
      record.updatedAt = nowIso();
      await this.persist();
      this.scheduleEvaluationFailureNotification(agentId, {
        condition: record.condition,
        reason: record.lastEvaluationReason,
      });
      return;
    }

    record.iteration = nextIteration;
    record.lastEvaluationReason = evaluation.reason;
    record.updatedAt = nowIso();

    if (evaluation.met) {
      record.status = "met";
      record.pauseReason = undefined;
      await this.persist();
      this.logger.info({ agentId, reason: evaluation.reason }, "goal-service: condition met");
      return;
    }

    await this.persist();
    this.scheduleContinuation(agentId, {
      condition: record.condition,
      reason: evaluation.reason,
      iteration: record.iteration,
      maxIterations: record.maxIterations,
    });
  }

  private async runEvaluation(
    agentId: string,
    condition: string,
  ): Promise<z.infer<typeof GoalEvaluationSchema>> {
    if (this.options.evaluateGoal) {
      return this.options.evaluateGoal({ agentId, condition });
    }
    return this.evaluateGoalWithStructuredGeneration(agentId, condition);
  }

  private async evaluateGoalWithStructuredGeneration(
    agentId: string,
    condition: string,
  ): Promise<z.infer<typeof GoalEvaluationSchema>> {
    const agent = this.options.agentManager.getAgent(agentId);
    if (!agent) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    const timeline = this.options.agentManager.getTimeline(agentId);
    const activity = curateAgentActivity(timeline, { maxItems: GOAL_ACTIVITY_MAX_ITEMS });
    const prompt = buildEvaluationPrompt(condition, activity);
    const providers = await resolveStructuredGenerationProviders({
      cwd: agent.cwd,
      providerSnapshotManager: this.options.providerSnapshotManager,
      daemonConfig: this.options.readDaemonConfig(),
    });
    return generateStructuredAgentResponseWithFallback({
      manager: this.options.agentManager as AgentManager,
      cwd: agent.cwd,
      prompt,
      schema: GoalEvaluationSchema,
      schemaName: "PaseoGoalEvaluation",
      maxRetries: 2,
      providers,
      persistSession: false,
      agentConfigOverrides: {
        title: "paseo-goal evaluator",
        internal: true,
      },
      logger: this.logger,
    });
  }

  private scheduleEvaluationFailureNotification(
    agentId: string,
    detail: { condition: string; reason: string },
  ): void {
    const prompt = formatSystemNotificationPrompt(formatGoalEvaluationFailurePrompt(detail));
    void (async () => {
      try {
        for await (const _event of this.options.agentManager.streamAgent(agentId, prompt)) {
          // Drain until the failure notification turn settles.
        }
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "goal-service: evaluation failure notify failed");
      }
    })();
    this.logger.info({ agentId }, "goal-service: evaluation failure notification scheduled");
  }

  private scheduleContinuation(
    agentId: string,
    detail: { condition: string; reason: string; iteration: number; maxIterations: number },
  ): void {
    const existing = this.pendingContinuations.get(agentId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.pendingContinuations.set(agentId, { timer: null });
    const timer = setTimeout(() => {
      const pending = this.pendingContinuations.get(agentId);
      if (!pending) {
        return;
      }
      pending.timer = null;
      this.pendingContinuations.delete(agentId);
      const prompt = formatSystemNotificationPrompt(formatGoalContinuationPrompt(detail));
      void (async () => {
        try {
          for await (const _event of this.options.agentManager.streamAgent(agentId, prompt)) {
            // Drain until the continuation turn settles.
          }
        } catch (error) {
          this.logger.warn({ err: error, agentId }, "goal-service: continuation failed");
        }
      })();
    }, 0);
    this.pendingContinuations.set(agentId, { timer });
    this.logger.info(
      { agentId, iteration: detail.iteration, maxIterations: detail.maxIterations },
      "goal-service: continuation scheduled",
    );
  }

  private clearPendingContinuation(agentId: string): void {
    const pending = this.pendingContinuations.get(agentId);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingContinuations.delete(agentId);
  }

  private async persist(): Promise<void> {
    const nextPersist = this.persistQueue.then(async () => {
      const payload: Record<string, GoalActiveRecord> = {};
      for (const [agentId, record] of this.goals.entries()) {
        payload[agentId] = cloneRecord(record);
      }
      await writeJsonFileAtomic(this.storePath, payload);
      return;
    });
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}
