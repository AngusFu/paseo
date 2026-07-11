import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { kanbanCardSchema } from "./schema.js";
import {
  connectKanbanClient,
  toKanbanCardRow,
  toKanbanCommandError,
  type KanbanCardRow,
  type KanbanCommandOptions,
} from "./shared.js";

export async function runSyncCommand(
  id: string,
  options: KanbanCommandOptions,
  _command: Command,
): Promise<ListResult<KanbanCardRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanSourceSync(id);
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.cards.map(toKanbanCardRow),
      schema: kanbanCardSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_SOURCE_SYNC_FAILED", "sync source", error);
  } finally {
    await client.close().catch(() => {});
  }
}
