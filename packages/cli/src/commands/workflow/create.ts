import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { workflowDefinitionSchema } from "./schema.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  parseWorkflowCreateInput,
  requireWorkflowValue,
  toWorkflowCommandError,
  toWorkflowDefinitionRow,
  type WorkflowCommandOptions,
  type WorkflowDefinitionRow,
} from "./shared.js";

export interface WorkflowCreateOptions extends WorkflowCommandOptions {
  name?: string;
  sourceFile?: string;
  source?: string;
  id?: string;
  description?: string;
}

export async function runCreateCommand(
  options: WorkflowCreateOptions,
  _command: Command,
): Promise<SingleResult<WorkflowDefinitionRow>> {
  const input = parseWorkflowCreateInput(options);
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowDefinitionCreate(input);
    const definition = requireWorkflowValue(payload, "Workflow definition creation failed");
    return {
      type: "single",
      data: toWorkflowDefinitionRow(definition),
      schema: workflowDefinitionSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_DEFINITION_CREATE_FAILED", "create definition", error);
  } finally {
    await client.close().catch(() => {});
  }
}
