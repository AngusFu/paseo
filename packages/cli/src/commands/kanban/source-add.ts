import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { kanbanSourceSchema } from "./schema.js";
import {
  connectKanbanClient,
  parseKanbanSourceAddInput,
  toKanbanCommandError,
  toKanbanSourceRow,
  type KanbanCommandOptions,
  type KanbanSourceRow,
} from "./shared.js";

export interface KanbanSourceAddOptions extends KanbanCommandOptions {
  kind?: string;
  name?: string;
  baseUrl?: string;
  query?: string;
  pollEverySec?: string;
  tokenRef?: string;
}

export async function runSourceAddCommand(
  options: KanbanSourceAddOptions,
  _command: Command,
): Promise<SingleResult<KanbanSourceRow>> {
  const input = parseKanbanSourceAddInput(options);
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanSourceCreate(input);
    if (payload.error || !payload.source) {
      throw new Error(payload.error ?? "Source creation failed");
    }
    return {
      type: "single",
      data: toKanbanSourceRow(payload.source),
      schema: kanbanSourceSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_SOURCE_ADD_FAILED", "add source", error);
  } finally {
    await client.close().catch(() => {});
  }
}
