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
}

export async function runRunCommand(
  definitionId: string,
  options: WorkflowRunOptions,
  _command: Command,
): Promise<SingleResult<WorkflowRunRow>> {
  const input = parseWorkflowDispatchInput(definitionId, options);
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
