import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { workflowDefinitionSchema } from "./schema.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  requireWorkflowValue,
  toWorkflowCommandError,
  toWorkflowDefinitionRow,
  type WorkflowCommandOptions,
  type WorkflowDefinitionRow,
} from "./shared.js";

export async function runLsCommand(
  options: WorkflowCommandOptions,
  _command: Command,
): Promise<ListResult<WorkflowDefinitionRow>> {
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowDefinitionList();
    const definitions = requireWorkflowValue(payload, "Failed to list workflow definitions");
    return {
      type: "list",
      data: definitions.map(toWorkflowDefinitionRow),
      schema: workflowDefinitionSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_DEFINITION_LIST_FAILED", "list definitions", error);
  } finally {
    await client.close().catch(() => {});
  }
}
