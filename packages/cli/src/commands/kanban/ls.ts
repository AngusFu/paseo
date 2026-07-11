import type { Command } from "commander";
import { KANBAN_STATUS_ORDER } from "@getpaseo/protocol/kanban/types";
import type { ListResult } from "../../output/index.js";
import { kanbanCardSchema } from "./schema.js";
import {
  connectKanbanClient,
  toKanbanCardRow,
  toKanbanCommandError,
  type KanbanCardRow,
  type KanbanCommandOptions,
} from "./shared.js";
import type { StoredKanbanCard } from "./types.js";

function sortByStatusThenOrder(cards: StoredKanbanCard[]): StoredKanbanCard[] {
  const statusRank = new Map(KANBAN_STATUS_ORDER.map((status, index) => [status, index]));
  return [...cards].sort((a, b) => {
    const rankDiff = (statusRank.get(a.status) ?? 0) - (statusRank.get(b.status) ?? 0);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return a.order - b.order;
  });
}

export async function runLsCommand(
  options: KanbanCommandOptions,
  _command: Command,
): Promise<ListResult<KanbanCardRow>> {
  const { client } = await connectKanbanClient(options.host);
  try {
    const payload = await client.kanbanCardList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: sortByStatusThenOrder(payload.cards).map(toKanbanCardRow),
      schema: kanbanCardSchema,
    };
  } catch (error) {
    throw toKanbanCommandError("KANBAN_CARD_LIST_FAILED", "list cards", error);
  } finally {
    await client.close().catch(() => {});
  }
}
