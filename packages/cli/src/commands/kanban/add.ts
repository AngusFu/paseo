import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { kanbanCardSchema } from "./schema.js";
import {
  connectKanbanClient,
  parseKanbanCardAddInput,
  toKanbanCardRow,
  toKanbanCommandError,
  type KanbanCardRow,
  type KanbanCommandOptions,
} from "./shared.js";

export interface KanbanAddOptions extends KanbanCommandOptions {
  title?: string;
  url?: string;
  status?: string;
  theme?: string;
  label?: string[];
  priority?: string;
}

export async function runAddCommand(
  options: KanbanAddOptions,
  _command: Command,
): Promise<SingleResult<KanbanCardRow>> {
  const input = parseKanbanCardAddInput(options);
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanCardCreate(input);
    if (payload.error || !payload.card) {
      throw new Error(payload.error ?? "Card creation failed");
    }
    return {
      type: "single",
      data: toKanbanCardRow(payload.card),
      schema: kanbanCardSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_CARD_ADD_FAILED", "add card", error);
  } finally {
    await client.close().catch(() => {});
  }
}
