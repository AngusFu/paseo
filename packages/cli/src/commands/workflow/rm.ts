import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import {
  assertWorkflowSupported,
  connectWorkflowClient,
  requireWorkflowValue,
  toWorkflowCommandError,
  type WorkflowCommandOptions,
} from "./shared.js";

interface WorkflowDeleteRow {
  id: string;
  status: string;
}

const workflowDeleteSchema: OutputSchema<WorkflowDeleteRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 16 },
    { header: "STATUS", field: "status", width: 12 },
  ],
};

export async function runRmCommand(
  definitionId: string,
  options: WorkflowCommandOptions,
  _command: Command,
): Promise<SingleResult<WorkflowDeleteRow>> {
  const { client } = await connectWorkflowClient(options.host);
  try {
    assertWorkflowSupported(client);
    const payload = await client.workflowDefinitionDelete(definitionId);
    const id = requireWorkflowValue(payload, `Failed to delete definition: ${definitionId}`);
    return {
      type: "single",
      data: {
        id,
        status: "deleted",
      },
      schema: workflowDeleteSchema,
    };
  } catch (error) {
    throw toWorkflowCommandError("WORKFLOW_DEFINITION_DELETE_FAILED", "delete definition", error);
  } finally {
    await client.close().catch(() => {});
  }
}
