import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { workflowRunSchema } from "./schema.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  parseWorkflowDispatchInput,
  requireWorkflowValue,
  toWorkflowCommandError,
  toWorkflowRunRow,
  type WorkflowCommandOptions,
  type WorkflowRunRow,
} from "./shared.js";

export interface WorkflowRunOptions extends WorkflowCommandOptions {
  arg?: string[];
  provider?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  fast?: boolean;
  cwd?: string;
  repoPath?: string;
  resumeFrom?: string;
}

// COMPAT(projectWorkflows): added in v0.1.112. A path-like argument that
// exists on disk (e.g. .paseo/workflows/review.flow.js) dispatches as a
// read-through `project:<abs path>` definition — the daemon reads the repo
// file fresh, no import into $PASEO_HOME needed.
function resolveDefinitionArgument(definitionId: string): string {
  const trimmed = definitionId.trim();
  const pathLike = trimmed.includes("/") || trimmed.endsWith(".flow.js") || trimmed.endsWith(".js");
  if (pathLike && existsSync(trimmed)) {
    return `project:${resolve(trimmed)}`;
  }
  return trimmed;
}

export async function runRunCommand(
  definitionId: string,
  options: WorkflowRunOptions,
  _command: Command,
): Promise<SingleResult<WorkflowRunRow>> {
  const input = {
    ...parseWorkflowDispatchInput(resolveDefinitionArgument(definitionId), options),
    ...(options.resumeFrom ? { resumeFromRunId: options.resumeFrom } : {}),
  };
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowRunDispatch(input);
    const run = requireWorkflowValue(payload, "Workflow run dispatch failed");
    return {
      type: "single",
      data: toWorkflowRunRow(run),
      schema: workflowRunSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_RUN_DISPATCH_FAILED", "dispatch run", error);
  } finally {
    await client.close().catch(() => {});
  }
}
