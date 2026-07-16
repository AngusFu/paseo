import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createWorkflowRunInspectRows,
  createWorkflowRunInspectSchema,
  type WorkflowInspectRow,
} from "./schema.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  requireWorkflowValue,
  toWorkflowCommandError,
  type WorkflowCommandOptions,
} from "./shared.js";

export async function runRunsInspectCommand(
  runId: string,
  options: WorkflowCommandOptions,
  _command: Command,
): Promise<ListResult<WorkflowInspectRow>> {
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowRunGet(runId);
    const run = requireWorkflowValue(payload, `Workflow run not found: ${runId}`);
    return {
      type: "list",
      data: createWorkflowRunInspectRows(run),
      schema: createWorkflowRunInspectSchema(run),
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_RUN_GET_FAILED", "inspect run", error);
  } finally {
    await client.close().catch(() => {});
  }
}
