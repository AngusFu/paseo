import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createWorkflowDefinitionInspectRows,
  createWorkflowDefinitionInspectSchema,
  type WorkflowInspectRow,
} from "./schema.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  requireWorkflowValue,
  toWorkflowCommandError,
  type WorkflowCommandOptions,
} from "./shared.js";

export async function runInspectCommand(
  definitionId: string,
  options: WorkflowCommandOptions,
  _command: Command,
): Promise<ListResult<WorkflowInspectRow>> {
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowDefinitionGet(definitionId);
    const definition = requireWorkflowValue(
      payload,
      `Workflow definition not found: ${definitionId}`,
    );
    return {
      type: "list",
      data: createWorkflowDefinitionInspectRows(definition),
      schema: createWorkflowDefinitionInspectSchema(definition),
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_DEFINITION_GET_FAILED", "inspect definition", error);
  } finally {
    await client.close().catch(() => {});
  }
}
