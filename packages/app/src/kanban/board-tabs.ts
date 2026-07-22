import { cardBelongsToSource, resolveCardSourceIds } from "@getpaseo/protocol/kanban/card-sources";
import type {
  KanbanSourceKind,
  StoredKanbanCard,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";

// One tab per CONFIGURED SOURCE, not per source kind. Two GitLab sources (a
// review queue and an authored-MR board, say) are two separate queues the user
// wants counted separately, and a card knows which sources it belongs to
// (StoredKanbanCard.sourceIds), so each gets its own tab and its own numbers.
//
// `key` is the tab's stable identity: it drives the segmented control value and
// the testID, and it is a source id for source tabs so a tab survives renames.
export type KanbanBoardTab =
  // Aggregate-only: per-source summary + focus row, no board underneath.
  | { type: "overview"; key: "overview"; kind: null }
  // A configured source's own queue.
  | { type: "source"; key: string; kind: KanbanSourceKind; sourceId: string }
  // Synced cards of a kind whose source was deleted. Without this they would be
  // reachable from no tab at all — the cards outlive the source that fetched
  // them (see KanbanStore.deleteSource), so they still need a home.
  | { type: "orphan"; key: string; kind: KanbanSourceKind }
  // Hand-created cards. Always present, always last.
  | { type: "manual"; key: "manual"; kind: null };

// Kind ordering for the tab strip; sources of the same kind then follow their
// configured order.
const KANBAN_SOURCE_KIND_ORDER: KanbanSourceKind[] = ["jira", "gitlab"];

const ORPHAN_TAB_PREFIX = "orphan:";

/** True when the card is backed by a source that no longer exists (or by none). */
function isOrphanedSyncedCard(card: StoredKanbanCard, liveSourceIds: Set<string>): boolean {
  if (card.source.kind === "manual") {
    return false;
  }
  return !resolveCardSourceIds(card).some((id) => liveSourceIds.has(id));
}

export function buildKanbanBoardTabs(input: {
  sources: StoredKanbanSource[];
  cards: StoredKanbanCard[];
}): KanbanBoardTab[] {
  const liveSourceIds = new Set(input.sources.map((source) => source.id));
  const sourceTabs = KANBAN_SOURCE_KIND_ORDER.flatMap<KanbanBoardTab>((kind) =>
    input.sources
      .filter((source) => source.kind === kind)
      .map((source) => ({ type: "source", key: source.id, kind, sourceId: source.id })),
  );
  const orphanTabs = KANBAN_SOURCE_KIND_ORDER.filter((kind) =>
    input.cards.some(
      (card) => card.source.kind === kind && isOrphanedSyncedCard(card, liveSourceIds),
    ),
  ).map<KanbanBoardTab>((kind) => ({
    type: "orphan",
    key: `${ORPHAN_TAB_PREFIX}${kind}`,
    kind,
  }));
  return [
    { type: "overview", key: "overview", kind: null },
    ...sourceTabs,
    ...orphanTabs,
    { type: "manual", key: "manual", kind: null },
  ];
}

/**
 * The cards a tab shows. Overview gets everything (it renders no board, but the
 * focus row still counts across the whole store).
 */
export function selectKanbanTabCards(input: {
  tab: KanbanBoardTab;
  cards: StoredKanbanCard[];
  sources: StoredKanbanSource[];
}): StoredKanbanCard[] {
  const { tab, cards } = input;
  switch (tab.type) {
    case "overview":
      return cards;
    case "manual":
      return cards.filter((card) => card.source.kind === "manual");
    case "source":
      return selectCardsForSource(cards, tab.sourceId);
    case "orphan": {
      const liveSourceIds = new Set(input.sources.map((source) => source.id));
      return cards.filter(
        (card) => card.source.kind === tab.kind && isOrphanedSyncedCard(card, liveSourceIds),
      );
    }
  }
}

/** The cards one configured source is responsible for — what its summary counts. */
export function selectCardsForSource(
  cards: StoredKanbanCard[],
  sourceId: string,
): StoredKanbanCard[] {
  return cards.filter((card) => cardBelongsToSource(card, sourceId));
}
