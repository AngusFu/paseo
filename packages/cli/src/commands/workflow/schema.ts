import type { OutputSchema } from "../../output/index.js";
import type { WorkflowDefinitionRow, WorkflowRunRow } from "./shared.js";
import type { WorkflowDefinition, WorkflowRun } from "./types.js";

export const workflowDefinitionSchema: OutputSchema<WorkflowDefinitionRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 16 },
    { header: "NAME", field: "name", width: 24 },
    { header: "BUILTIN", field: "builtin", width: 8 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
    { header: "DESCRIPTION", field: "description", width: 36 },
  ],
};

export const workflowRunSchema: OutputSchema<WorkflowRunRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 16 },
    { header: "DEFINITION", field: "definitionId", width: 16 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "QUEUED", field: "queuedAt", width: 24 },
    { header: "STARTED", field: "startedAt", width: 24 },
    { header: "ENDED", field: "endedAt", width: 24 },
    { header: "CWD", field: "cwd", width: 36 },
  ],
};

export interface WorkflowInspectRow {
  key: string;
  value: string;
}

export function createWorkflowDefinitionInspectSchema(
  definition: WorkflowDefinition,
): OutputSchema<WorkflowInspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key", width: 18 },
      { header: "VALUE", field: "value", width: 80 },
    ],
    serialize: () => definition,
  };
}

export function createWorkflowDefinitionInspectRows(
  definition: WorkflowDefinition,
): WorkflowInspectRow[] {
  return [
    { key: "Id", value: definition.id },
    { key: "Name", value: definition.name },
    { key: "Builtin", value: `${definition.builtin}` },
    { key: "Description", value: definition.description ?? "null" },
    { key: "CreatedAt", value: definition.createdAt },
    { key: "UpdatedAt", value: definition.updatedAt },
    { key: "Source", value: truncate(definition.source, 240) },
  ];
}

export function createWorkflowRunInspectSchema(run: WorkflowRun): OutputSchema<WorkflowInspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key", width: 18 },
      { header: "VALUE", field: "value", width: 80 },
    ],
    serialize: () => run,
  };
}

export function createWorkflowRunInspectRows(run: WorkflowRun): WorkflowInspectRow[] {
  return [
    { key: "Id", value: run.id },
    { key: "DefinitionId", value: run.definitionId },
    { key: "Status", value: run.status },
    { key: "Cwd", value: run.cwd ?? "null" },
    { key: "WorkspaceId", value: run.workspaceId ?? "null" },
    { key: "WorkspacePath", value: run.workspacePath },
    { key: "QueuedAt", value: run.queuedAt },
    { key: "StartedAt", value: run.startedAt ?? "null" },
    { key: "EndedAt", value: run.endedAt ?? "null" },
    { key: "Error", value: run.error ?? "null" },
    { key: "Args", value: truncate(JSON.stringify(run.args ?? {}), 240) },
    { key: "Result", value: truncate(JSON.stringify(run.result ?? null), 240) },
  ];
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}
