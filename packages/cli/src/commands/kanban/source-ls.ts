import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { kanbanSourceSchema } from "./schema.js";
import {
  connectKanbanClient,
  toKanbanCommandError,
  toKanbanSourceRow,
  type KanbanCommandOptions,
  type KanbanSourceRow,
} from "./shared.js";

export async function runSourceLsCommand(
  options: KanbanCommandOptions,
  _command: Command,
): Promise<ListResult<KanbanSourceRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanSourceList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.sources.map(toKanbanSourceRow),
      schema: kanbanSourceSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_SOURCE_LIST_FAILED", "list sources", error);
  } finally {
    await client.close().catch(() => {});
  }
}
