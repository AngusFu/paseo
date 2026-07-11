import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { createKanbanCardInspectRows, createKanbanCardInspectSchema } from "./schema.js";
import type { KanbanCardInspectRow } from "./schema.js";
import { connectKanbanClient, toKanbanCommandError, type KanbanCommandOptions } from "./shared.js";

export async function runInspectCommand(
  id: string,
  options: KanbanCommandOptions,
  _command: Command,
): Promise<ListResult<KanbanCardInspectRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanCardInspect(id);
    if (payload.error || !payload.card) {
      throw new Error(payload.error ?? `Card not found: ${id}`);
    }
    return {
      type: "list",
      data: createKanbanCardInspectRows(payload.card),
      schema: createKanbanCardInspectSchema(payload.card),
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_CARD_INSPECT_FAILED", "inspect card", error);
  } finally {
    await client.close().catch(() => {});
  }
}
