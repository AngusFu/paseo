import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
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

export async function runRunsCancelCommand(
  runId: string,
  options: WorkflowCommandOptions,
  _command: Command,
): Promise<SingleResult<WorkflowRunRow>> {
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowRunCancel(runId);
    const run = requireWorkflowValue(payload, `Failed to cancel run: ${runId}`);
    return {
      type: "single",
      data: toWorkflowRunRow(run),
      schema: workflowRunSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_RUN_CANCEL_FAILED", "cancel run", error);
  } finally {
    await client.close().catch(() => {});
  }
}
