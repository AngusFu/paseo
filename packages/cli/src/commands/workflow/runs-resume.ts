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

/**
 * Resume a failed/cancelled run: dispatch a new run of the same definition
 * with resumeFromRunId — the daemon copies the prior run's journal so
 * successful agent calls replay at zero cost.
 */
export async function runRunsResumeCommand(
  runId: string,
  options: WorkflowCommandOptions,
  _command: Command,
): Promise<SingleResult<WorkflowRunRow>> {
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const priorPayload = await client.workflowRunGet(runId);
    const prior = requireWorkflowValue(priorPayload, `Workflow run not found: ${runId}`);
    const payload = await client.workflowRunDispatch({
      definitionId: prior.definitionId,
      resumeFromRunId: prior.id,
    });
    const run = requireWorkflowValue(payload, "Workflow run resume failed");
    return {
      type: "single",
      data: toWorkflowRunRow(run),
      schema: workflowRunSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_RUN_RESUME_FAILED", "resume run", error);
  } finally {
    await client.close().catch(() => {});
  }
}
