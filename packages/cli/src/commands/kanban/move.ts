import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { kanbanCardSchema } from "./schema.js";
import {
  connectKanbanClient,
  parseKanbanCardMoveInput,
  toKanbanCardRow,
  toKanbanCommandError,
  type KanbanCardRow,
  type KanbanCommandOptions,
} from "./shared.js";

export interface KanbanMoveOptions extends KanbanCommandOptions {
  status?: string;
  order?: string;
}

export async function runMoveCommand(
  id: string,
  options: KanbanMoveOptions,
  _command: Command,
): Promise<SingleResult<KanbanCardRow>> {
  const input = parseKanbanCardMoveInput(id, options);
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanCardMove(input);
    if (payload.error || !payload.card) {
      throw new Error(payload.error ?? `Failed to move card: ${id}`);
    }
    return {
      type: "single",
      data: toKanbanCardRow(payload.card),
      schema: kanbanCardSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_CARD_MOVE_FAILED", "move card", error);
  } finally {
    await client.close().catch(() => {});
  }
}
