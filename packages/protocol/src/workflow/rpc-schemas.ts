import { z } from "zod";
import {
  KanbanWorkflowFilterSchema,
  KanbanWorkflowRuleSchema,
  WorkflowDefinitionSchema,
  WorkflowRunSchema,
} from "./types.js";

function response<const Type extends string>(type: Type, value: z.ZodType) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), value, error: z.string().nullable() }),
  });
}

export const WorkflowDefinitionListRequestSchema = z.object({
  type: z.literal("workflow.definition.list.request"),
  requestId: z.string(),
});
export const WorkflowDefinitionGetRequestSchema = z.object({
  type: z.literal("workflow.definition.get.request"),
  requestId: z.string(),
  definitionId: z.string(),
});
export const WorkflowDefinitionCreateRequestSchema = z.object({
  type: z.literal("workflow.definition.create.request"),
  requestId: z.string(),
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  source: z.string().min(1),
});
export const WorkflowDefinitionUpdateRequestSchema = z.object({
  type: z.literal("workflow.definition.update.request"),
  requestId: z.string(),
  definitionId: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  source: z.string().min(1).optional(),
});
export const WorkflowDefinitionDeleteRequestSchema = z.object({
  type: z.literal("workflow.definition.delete.request"),
  requestId: z.string(),
  definitionId: z.string(),
});
export const WorkflowDefinitionListBuiltinsRequestSchema = z.object({
  type: z.literal("workflow.definition.list_builtins.request"),
  requestId: z.string(),
});
export const WorkflowRunListRequestSchema = z.object({
  type: z.literal("workflow.run.list.request"),
  requestId: z.string(),
});
export const WorkflowRunGetRequestSchema = z.object({
  type: z.literal("workflow.run.get.request"),
  requestId: z.string(),
  runId: z.string(),
});
export const WorkflowRunDispatchRequestSchema = z.object({
  type: z.literal("workflow.run.dispatch.request"),
  requestId: z.string(),
  definitionId: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().optional(),
  repoPath: z.string().optional(),
});
export const WorkflowRunCancelRequestSchema = z.object({
  type: z.literal("workflow.run.cancel.request"),
  requestId: z.string(),
  runId: z.string(),
});
export const KanbanRuleListRequestSchema = z.object({
  type: z.literal("kanban.rule.list.request"),
  requestId: z.string(),
});
export const KanbanRuleCreateRequestSchema = z.object({
  type: z.literal("kanban.rule.create.request"),
  requestId: z.string(),
  sourceId: z.string(),
  enabled: z.boolean().optional(),
  workflowDefinitionId: z.string(),
  filter: KanbanWorkflowFilterSchema.optional(),
});
export const KanbanRuleUpdateRequestSchema = z.object({
  type: z.literal("kanban.rule.update.request"),
  requestId: z.string(),
  ruleId: z.string(),
  enabled: z.boolean().optional(),
  workflowDefinitionId: z.string().optional(),
  filter: KanbanWorkflowFilterSchema.optional(),
});
export const KanbanRuleDeleteRequestSchema = z.object({
  type: z.literal("kanban.rule.delete.request"),
  requestId: z.string(),
  ruleId: z.string(),
});

export const WorkflowDefinitionListResponseSchema = response(
  "workflow.definition.list.response",
  z.array(WorkflowDefinitionSchema),
);
export const WorkflowDefinitionGetResponseSchema = response(
  "workflow.definition.get.response",
  WorkflowDefinitionSchema.nullable(),
);
export const WorkflowDefinitionCreateResponseSchema = response(
  "workflow.definition.create.response",
  WorkflowDefinitionSchema.nullable(),
);
export const WorkflowDefinitionUpdateResponseSchema = response(
  "workflow.definition.update.response",
  WorkflowDefinitionSchema.nullable(),
);
export const WorkflowDefinitionDeleteResponseSchema = response(
  "workflow.definition.delete.response",
  z.string(),
);
export const WorkflowDefinitionListBuiltinsResponseSchema = response(
  "workflow.definition.list_builtins.response",
  z.array(WorkflowDefinitionSchema),
);
export const WorkflowRunListResponseSchema = response(
  "workflow.run.list.response",
  z.array(WorkflowRunSchema),
);
export const WorkflowRunGetResponseSchema = response(
  "workflow.run.get.response",
  WorkflowRunSchema.nullable(),
);
export const WorkflowRunDispatchResponseSchema = response(
  "workflow.run.dispatch.response",
  WorkflowRunSchema.nullable(),
);
export const WorkflowRunCancelResponseSchema = response(
  "workflow.run.cancel.response",
  WorkflowRunSchema.nullable(),
);
export const KanbanRuleListResponseSchema = response(
  "kanban.rule.list.response",
  z.array(KanbanWorkflowRuleSchema),
);
export const KanbanRuleCreateResponseSchema = response(
  "kanban.rule.create.response",
  KanbanWorkflowRuleSchema.nullable(),
);
export const KanbanRuleUpdateResponseSchema = response(
  "kanban.rule.update.response",
  KanbanWorkflowRuleSchema.nullable(),
);
export const KanbanRuleDeleteResponseSchema = response("kanban.rule.delete.response", z.string());
