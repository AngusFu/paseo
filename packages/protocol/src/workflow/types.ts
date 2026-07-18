import { z } from "zod";

export const WorkflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().nullable(),
  source: z.string(),
  builtin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // COMPAT(projectWorkflows): added in v0.1.112. Where the definition lives:
  // "store" ($PASEO_HOME), "builtin" (package), "project" (read-through from a
  // repo's .paseo/workflows or .claude/workflows). Absent = store/builtin per
  // the `builtin` flag (old daemons). Project definitions are read-only over
  // the wire — fork to a user definition to edit.
  origin: z.enum(["store", "builtin", "project"]).optional(),
  // Absolute path of the backing file for origin "project".
  sourcePath: z.string().optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowRunSchema = z.object({
  id: z.string(),
  definitionId: z.string(),
  status: WorkflowRunStatusSchema,
  args: z.record(z.string(), z.unknown()),
  cwd: z.string(),
  workspaceId: z.string().nullable(),
  workspacePath: z.string(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/** Append-only workflow event log entry (per-run + global jsonl). */
export const WorkflowLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type WorkflowLogLevel = z.infer<typeof WorkflowLogLevelSchema>;

export const WorkflowLogEntrySchema = z.object({
  seq: z.number(),
  ts: z.string(),
  level: WorkflowLogLevelSchema,
  event: z.string(),
  message: z.string(),
  runId: z.string().optional(),
  definitionId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowLogEntry = z.infer<typeof WorkflowLogEntrySchema>;

export const KanbanWorkflowFilterSchema = z.object({
  labelsAny: z.array(z.string()).optional(),
  titleRegex: z.string().optional(),
  projectKey: z.string().optional(),
});
export type KanbanWorkflowFilter = z.infer<typeof KanbanWorkflowFilterSchema>;

export const KanbanWorkflowRuleSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  enabled: z.boolean(),
  workflowDefinitionId: z.string(),
  filter: KanbanWorkflowFilterSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KanbanWorkflowRule = z.infer<typeof KanbanWorkflowRuleSchema>;

export interface CreateWorkflowDefinitionInput {
  id?: string;
  name: string;
  description?: string | null;
  source: string;
}

export interface UpdateWorkflowDefinitionInput {
  id: string;
  name?: string;
  description?: string | null;
  source?: string;
}

export interface DispatchWorkflowRunInput {
  definitionId: string;
  args?: Record<string, unknown>;
  cwd?: string;
  repoPath?: string;
  /** Display title for the Paseo workspace minted for this run's agents. */
  workspaceTitle?: string;
}

export interface CreateKanbanWorkflowRuleInput {
  sourceId: string;
  enabled?: boolean;
  workflowDefinitionId: string;
  filter?: KanbanWorkflowFilter;
}

export interface UpdateKanbanWorkflowRuleInput {
  id: string;
  enabled?: boolean;
  workflowDefinitionId?: string;
  filter?: KanbanWorkflowFilter;
}
