import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { kanbanCardSchema } from "./schema.js";
import {
  connectKanbanClient,
  parseKanbanCardUpdateInput,
  toKanbanCardRow,
  toKanbanCommandError,
  type KanbanCardRow,
  type KanbanCommandOptions,
} from "./shared.js";

export interface KanbanUpdateOptions extends KanbanCommandOptions {
  title?: string;
  url?: string;
  status?: string;
  theme?: string;
  label?: string[];
  priority?: string;
}

export async function runUpdateCommand(
  id: string,
  options: KanbanUpdateOptions,
  _command: Command,
): Promise<SingleResult<KanbanCardRow>> {
  const input = parseKanbanCardUpdateInput(id, options);
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanCardUpdate(input);
    if (payload.error || !payload.card) {
      throw new Error(payload.error ?? `Failed to update card: ${id}`);
    }
    return {
      type: "single",
      data: toKanbanCardRow(payload.card),
      schema: kanbanCardSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_CARD_UPDATE_FAILED", "update card", error);
  } finally {
    await client.close().catch(() => {});
  }
}
