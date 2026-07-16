import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { workflowRunSchema } from "./schema.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  requireWorkflowValue,
  toWorkflowCommandError,
  toWorkflowRunRow,
  type WorkflowCommandOptions,
  type WorkflowRunRow,
} from "./shared.js";

export async function runRunsLsCommand(
  options: WorkflowCommandOptions,
  _command: Command,
): Promise<ListResult<WorkflowRunRow>> {
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowRunList();
    const runs = requireWorkflowValue(payload, "Failed to list workflow runs");
    return {
      type: "list",
      data: [...runs].sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).map(toWorkflowRunRow),
      schema: workflowRunSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_RUN_LIST_FAILED", "list runs", error);
  } finally {
    await client.close().catch(() => {});
  }
}
