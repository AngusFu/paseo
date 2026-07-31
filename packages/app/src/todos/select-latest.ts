import type { StreamItem, TodoEntry } from "@/types/stream";

export interface LatestTodoList {
  id: string;
  items: TodoEntry[];
}

/** Track: most recent non-empty todo_list (skips trailing empty clears). */
export function selectLatestTodoListForTrack(
  streamItems: readonly StreamItem[],
): LatestTodoList | null {
  for (let index = streamItems.length - 1; index >= 0; index -= 1) {
    const item = streamItems[index];
    if (item?.kind !== "todo_list" || item.items.length === 0) {
      continue;
    }
    return { id: item.id, items: item.items };
  }
  return null;
}

/** Timeline hide: id of the last todo_list, including empty items. */
export function selectLatestTodoListIdForHide(streamItems: readonly StreamItem[]): string | null {
  for (let index = streamItems.length - 1; index >= 0; index -= 1) {
    const item = streamItems[index];
    if (item?.kind === "todo_list") {
      return item.id;
    }
  }
  return null;
}
