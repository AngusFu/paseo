import { useMemo, useState } from "react";
import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";

// Cards carry only `source.kind` (jira/gitlab/manual), never a sourceId back
// to a specific configured source — see KanbanCardSourceSchema and the sync
// upsert payloads in packages/server/src/server/kanban/sync.ts. So "source
// filter" here means the tracker kind, not an individual configured source.
export type KanbanCardSourceKindFilter = "all" | "jira" | "gitlab" | "manual";

// Sentinel for "cards with no assignee", distinct from the `null` that means
// "no assignee filter applied" (all cards).
export const UNASSIGNED_ASSIGNEE_FILTER = "__unassigned__";

export interface UseKanbanCardFiltersResult {
  search: string;
  setSearch: (value: string) => void;
  clearSearch: () => void;
  sourceKind: KanbanCardSourceKindFilter;
  setSourceKind: (value: KanbanCardSourceKindFilter) => void;
  clearSourceKind: () => void;
  assignee: string | null;
  setAssignee: (value: string | null) => void;
  clearAssignee: () => void;
  assigneeOptions: string[];
  hasUnassignedCards: boolean;
  isActive: boolean;
  filteredCards: StoredKanbanCard[];
}

function cardIssueKeyText(card: StoredKanbanCard): string | null {
  if (card.source.kind === "jira") return card.source.issueKey;
  if (card.source.kind === "gitlab") return card.source.mrIid;
  return null;
}

function matchesSearch(card: StoredKanbanCard, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  if (card.title.toLowerCase().includes(normalizedQuery)) return true;
  const issueKey = cardIssueKeyText(card);
  return issueKey ? issueKey.toLowerCase().includes(normalizedQuery) : false;
}

function matchesSourceKind(
  card: StoredKanbanCard,
  sourceKind: KanbanCardSourceKindFilter,
): boolean {
  if (sourceKind === "all") return true;
  return card.source.kind === sourceKind;
}

function matchesAssignee(card: StoredKanbanCard, assignee: string | null): boolean {
  if (assignee === null) return true;
  if (assignee === UNASSIGNED_ASSIGNEE_FILTER) return !card.assignee;
  return card.assignee === assignee;
}

export function useKanbanCardFilters(cards: StoredKanbanCard[]): UseKanbanCardFiltersResult {
  const [search, setSearch] = useState("");
  const [sourceKind, setSourceKind] = useState<KanbanCardSourceKindFilter>("all");
  const [assignee, setAssignee] = useState<string | null>(null);

  const { assigneeOptions, hasUnassignedCards } = useMemo(() => {
    const seen = new Set<string>();
    let sawUnassigned = false;
    for (const card of cards) {
      if (card.assignee) {
        seen.add(card.assignee);
      } else {
        sawUnassigned = true;
      }
    }
    return {
      assigneeOptions: Array.from(seen).sort((a, b) => a.localeCompare(b)),
      hasUnassignedCards: sawUnassigned,
    };
  }, [cards]);

  const filteredCards = useMemo(() => {
    const normalizedQuery = search.trim().toLowerCase();
    if (!normalizedQuery && sourceKind === "all" && assignee === null) {
      return cards;
    }
    return cards.filter(
      (card) =>
        matchesSearch(card, normalizedQuery) &&
        matchesSourceKind(card, sourceKind) &&
        matchesAssignee(card, assignee),
    );
  }, [cards, search, sourceKind, assignee]);

  return {
    search,
    setSearch,
    clearSearch: () => setSearch(""),
    sourceKind,
    setSourceKind,
    clearSourceKind: () => setSourceKind("all"),
    assignee,
    setAssignee,
    clearAssignee: () => setAssignee(null),
    assigneeOptions,
    hasUnassignedCards,
    isActive: search.trim() !== "" || sourceKind !== "all" || assignee !== null,
    filteredCards,
  };
}
