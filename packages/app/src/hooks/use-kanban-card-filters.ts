import { useMemo, useState } from "react";
import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";

// Cards carry only `source.kind` (jira/gitlab/manual), never a sourceId back
// to a specific configured source — see KanbanCardSourceSchema and the sync
// upsert payloads in packages/server/src/server/kanban/sync.ts. So "source
// filter" here means the tracker kind, not an individual configured source.
export type KanbanCardSourceKindFilter = "all" | "jira" | "gitlab" | "manual";

// Recency window applied to a card's tracker last-updated time. Default hides
// stale tickets; "all" shows every card regardless of age. The daemon always
// syncs and stores the full board — this is a client-side view filter only.
export type KanbanCardDateRangeFilter = "7d" | "2w" | "1m" | "2m" | "3m" | "all";

export const KANBAN_DATE_RANGE_DEFAULT: KanbanCardDateRangeFilter = "1m";

export const KANBAN_DATE_RANGE_OPTIONS: KanbanCardDateRangeFilter[] = [
  "7d",
  "2w",
  "1m",
  "2m",
  "3m",
  "all",
];

const DAY_MS = 24 * 60 * 60 * 1000;
const KANBAN_DATE_RANGE_MS: Record<Exclude<KanbanCardDateRangeFilter, "all">, number> = {
  "7d": 7 * DAY_MS,
  "2w": 14 * DAY_MS,
  "1m": 30 * DAY_MS,
  "2m": 60 * DAY_MS,
  "3m": 90 * DAY_MS,
};

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
  dateRange: KanbanCardDateRangeFilter;
  setDateRange: (value: KanbanCardDateRangeFilter) => void;
  clearDateRange: () => void;
  isActive: boolean;
  clearAll: () => void;
  filteredCards: StoredKanbanCard[];
}

// A tracker timestamp lifted from the raw metadata blob, for cards synced
// before the typed sourceCreatedAt/sourceUpdatedAt fields existed. GitLab MRs
// store the whole MR (updated_at/created_at); Jira issues store fields
// (updated/created). Prefer "updated" over "created", newest source first.
function trackerTimeFromMetadata(card: StoredKanbanCard): string | null {
  const meta = card.metadata;
  if (!meta) return null;
  for (const key of ["updated_at", "updated", "created_at", "created"] as const) {
    const value = meta[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// A card's tracker last-updated time, falling back to its created time, then to
// the raw metadata blob (pre-upgrade cards without the typed fields). Manual
// cards and anything with no tracker timestamp return null and are never hidden
// by the recency filter.
function cardActivityTime(card: StoredKanbanCard): number | null {
  const iso = card.sourceUpdatedAt ?? card.sourceCreatedAt ?? trackerTimeFromMetadata(card);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function matchesDateRange(card: StoredKanbanCard, cutoff: number | null): boolean {
  if (cutoff === null) return true;
  const activity = cardActivityTime(card);
  if (activity === null) return true;
  return activity >= cutoff;
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
  const [dateRange, setDateRange] = useState<KanbanCardDateRangeFilter>(KANBAN_DATE_RANGE_DEFAULT);

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
    const cutoff = dateRange === "all" ? null : Date.now() - KANBAN_DATE_RANGE_MS[dateRange];
    if (!normalizedQuery && sourceKind === "all" && assignee === null && cutoff === null) {
      return cards;
    }
    return cards.filter(
      (card) =>
        matchesSearch(card, normalizedQuery) &&
        matchesSourceKind(card, sourceKind) &&
        matchesAssignee(card, assignee) &&
        matchesDateRange(card, cutoff),
    );
  }, [cards, search, sourceKind, assignee, dateRange]);

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
    dateRange,
    setDateRange,
    clearDateRange: () => setDateRange(KANBAN_DATE_RANGE_DEFAULT),
    isActive:
      search.trim() !== "" ||
      sourceKind !== "all" ||
      assignee !== null ||
      dateRange !== KANBAN_DATE_RANGE_DEFAULT,
    clearAll: () => {
      setSearch("");
      setSourceKind("all");
      setAssignee(null);
      setDateRange(KANBAN_DATE_RANGE_DEFAULT);
    },
    filteredCards,
  };
}
