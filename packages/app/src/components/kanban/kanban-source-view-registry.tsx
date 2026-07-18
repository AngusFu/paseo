import type { ComponentType } from "react";
import type { KanbanSourceKind } from "@getpaseo/protocol/kanban/types";
import { KanbanBoard, type KanbanBoardProps } from "@/components/kanban/kanban-board";
import { KanbanGitlabBoard } from "@/components/kanban/kanban-gitlab-board";
import { KanbanJiraBoard } from "@/components/kanban/kanban-jira-board";

// The kanban screen is a tab host: Overview + one tab per source kind present
// on the board (docs/kanban.md multi-tab roadmap, 2026-07-17). Each tab's view
// is picked here by source kind so a future Jira-specific board (P2/P3) or
// GitLab MR view (P4) can register without the screen knowing about it.
// Overview and any kind with no registered view fall back to the existing
// cross-source KanbanBoard, scoped by the screen to that tab's cards.
const SOURCE_VIEW_REGISTRY: Partial<Record<KanbanSourceKind, ComponentType<KanbanBoardProps>>> = {
  jira: KanbanJiraBoard,
  gitlab: KanbanGitlabBoard,
};

export function resolveKanbanSourceView(
  kind: KanbanSourceKind | null,
): ComponentType<KanbanBoardProps> {
  if (kind) {
    const registered = SOURCE_VIEW_REGISTRY[kind];
    if (registered) {
      return registered;
    }
  }
  return KanbanBoard;
}
