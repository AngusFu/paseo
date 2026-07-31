import type { TodoEntry } from "@/types/stream";

export interface TodoListPresentation {
  currentIndex: number;
  secondaryLabel: string | undefined;
  completedCount: number;
  total: number;
}

export function deriveTodoListPresentation(items: readonly TodoEntry[]): TodoListPresentation {
  const total = items.length;
  let completedCount = 0;
  for (const item of items) {
    if (item.completed) {
      completedCount += 1;
    }
  }

  // Current task = the in-progress row, or the first pending row if none is
  // marked in progress. Drives both the header preview and the row highlight.
  let currentIndex = items.findIndex((item) => item.status === "in_progress");
  if (currentIndex === -1) {
    currentIndex = items.findIndex((item) => !item.completed);
  }

  const currentTask = currentIndex === -1 ? undefined : items[currentIndex]?.text;
  let secondaryLabel: string | undefined;
  if (total > 0) {
    const progress = `${completedCount}/${total}`;
    secondaryLabel = currentTask ? `${progress} · ${currentTask}` : progress;
  }

  return { currentIndex, secondaryLabel, completedCount, total };
}
