import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import type { OutputSchema } from "../../output/index.js";
import { connectKanbanClient, toKanbanCommandError, type KanbanCommandOptions } from "./shared.js";

interface KanbanDeleteRow {
  id: string;
  status: string;
}

const kanbanDeleteSchema: OutputSchema<KanbanDeleteRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "STATUS", field: "status", width: 12 },
  ],
};

export async function runRmCommand(
  id: string,
  options: KanbanCommandOptions,
  _command: Command,
): Promise<SingleResult<KanbanDeleteRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanCardDelete(id);
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "single",
      data: {
        id: payload.cardId,
        status: "deleted",
      },
      schema: kanbanDeleteSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_CARD_DELETE_FAILED", "delete card", error);
  } finally {
    await client.close().catch(() => {});
  }
}
