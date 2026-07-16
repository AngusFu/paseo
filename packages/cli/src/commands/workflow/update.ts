import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { workflowDefinitionSchema } from "./schema.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  parseWorkflowUpdateInput,
  requireWorkflowValue,
  toWorkflowCommandError,
  toWorkflowDefinitionRow,
  type WorkflowCommandOptions,
  type WorkflowDefinitionRow,
} from "./shared.js";

export interface WorkflowUpdateOptions extends WorkflowCommandOptions {
  name?: string;
  description?: string;
  sourceFile?: string;
  source?: string;
}

export async function runUpdateCommand(
  definitionId: string,
  options: WorkflowUpdateOptions,
  _command: Command,
): Promise<SingleResult<WorkflowDefinitionRow>> {
  const input = parseWorkflowUpdateInput(definitionId, options);
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowDefinitionUpdate(input);
    const definition = requireWorkflowValue(payload, "Workflow definition update failed");
    return {
      type: "single",
      data: toWorkflowDefinitionRow(definition),
      schema: workflowDefinitionSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_DEFINITION_UPDATE_FAILED", "update definition", error);
  } finally {
    await client.close().catch(() => {});
  }
}
