import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  KanbanCardTransition,
  KanbanExternalStatus,
  StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import type { KanbanBoardProps } from "@/components/kanban/kanban-board";
import { KanbanCard } from "@/components/kanban/kanban-card";
import { KanbanCardDetailSheet } from "@/components/kanban/kanban-card-detail-sheet";
import { KanbanCardDispatchSheet } from "@/components/kanban/kanban-card-dispatch-sheet";
import { KanbanCardSheet } from "@/components/kanban/kanban-card-sheet";
import {
  KanbanStatusBoard,
  type KanbanStatusBucket,
} from "@/components/kanban/kanban-status-board";
import { KanbanTransitionPickerSheet } from "@/components/kanban/kanban-transition-picker-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useKanbanSourceStatuses } from "@/hooks/use-kanban-source-statuses";
import { useKanbanWriteback } from "@/hooks/use-kanban-writeback";
import { useHostFeature } from "@/runtime/host-features";

// Jira's own statusCategory bucket (todo/in-progress/done), used only to
// ORDER the lanes left-to-right — the lane itself is still one per exact
// status name, never collapsed into the three categories.
const CATEGORY_ORDER: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
const UNKNOWN_CATEGORY_ORDER = 3;
// Within one category, lanes follow the sequence Jira's /project/{key}/statuses
// API returned — that is the workflow's own definition order (the server
// preserves it end-to-end). Alphabetical here was a real ordering bug: it put
// "In QA" before "Pending Code Review". CATEGORY_SPAN just keeps the category
// rank dominant over the in-category index.
const CATEGORY_SPAN = 1000;
// Cross-column swimlanes don't fire actual card presses (used for the detail
// sheet) — width matches the real board column so the grid still reads as a
// Jira-style swimlane matrix.
const SWIMLANE_COLUMN_WIDTH = 260;
const SWIMLANE_LABEL_WIDTH = 140;
const UNASSIGNED_LANE_KEY = "__unassigned__";

function categoryOrder(categoryKey: string | null | undefined): number {
  return categoryKey !== null && categoryKey !== undefined && categoryKey in CATEGORY_ORDER
    ? CATEGORY_ORDER[categoryKey]
    : UNKNOWN_CATEGORY_ORDER;
}

// Reads {name, statusCategory.key} off a synced Jira card's raw metadata
// blob (packages/server/src/server/kanban/sync.ts stores the full Jira
// `fields.status` object there). Pure + defensive: metadata is
// `Record<string, unknown> | undefined` on the wire, so every level is
// narrowed before use instead of assumed.
function readJiraStatus(metadata: Record<string, unknown> | undefined): {
  name: string;
  order: number;
} | null {
  const status = metadata?.status;
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    return null;
  }
  const name = (status as Record<string, unknown>).name;
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  const category = (status as Record<string, unknown>).statusCategory;
  const categoryKey =
    typeof category === "object" && category !== null && !Array.isArray(category)
      ? (category as Record<string, unknown>).key
      : undefined;
  return { name, order: categoryOrder(typeof categoryKey === "string" ? categoryKey : undefined) };
}

// With `fullStatuses` (kanbanSourceStatuses capability): every workflow
// status gets a lane up front, including ones with zero cards right now —
// team lead's "state complete mapping, empty lanes too" requirement. Without
// it: unchanged dynamic behavior, a lane only exists for statuses actually
// present on the board right now. Either way, a card whose own status isn't
// in `fullStatuses` (workflow changed since the last full fetch) still gets
// a lane appended for it — cards never disappear.
function buildJiraBuckets(
  cards: StoredKanbanCard[],
  fullStatuses: KanbanExternalStatus[] | null,
  t: TFunction,
): KanbanStatusBucket[] {
  const byKey = new Map<string, { title: string; order: number; cards: StoredKanbanCard[] }>();
  if (fullStatuses) {
    fullStatuses.forEach((status, index) => {
      byKey.set(status.name, {
        title: status.name,
        // category first, then the workflow-definition sequence from the API.
        order: categoryOrder(status.category) * CATEGORY_SPAN + index,
        cards: [],
      });
    });
  }
  for (const card of cards) {
    const status = readJiraStatus(card.metadata);
    const key = status?.name ?? `legacy:${card.status}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        title: status?.name ?? t(`kanban.columns.${card.status}`),
        // A status missing from fullStatuses (workflow changed / no full
        // fetch) lands at the END of its category, not alphabetically inside.
        order: (status?.order ?? UNKNOWN_CATEGORY_ORDER) * CATEGORY_SPAN + CATEGORY_SPAN - 1,
        cards: [],
      };
      byKey.set(key, bucket);
    }
    bucket.cards.push(card);
  }
  return Array.from(byKey.entries())
    .map(([id, bucket]) => ({ id, title: bucket.title, cards: bucket.cards, order: bucket.order }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

interface JiraSwimlane {
  key: string;
  label: string;
  cardsByBucket: Map<string, StoredKanbanCard[]>;
}

// One row per assignee, columns = the same status buckets as the flat board.
// Unassigned sorts last; everyone else alphabetically, matching Jira's own
// swimlane ordering convention.
function buildJiraSwimlanes(buckets: KanbanStatusBucket[], t: TFunction): JiraSwimlane[] {
  const lanes = new Map<string, JiraSwimlane>();
  for (const bucket of buckets) {
    for (const card of bucket.cards) {
      const key = card.assignee ?? UNASSIGNED_LANE_KEY;
      let lane = lanes.get(key);
      if (!lane) {
        lane = {
          key,
          label: card.assignee ?? t("kanban.filters.assignee.unassigned"),
          cardsByBucket: new Map(),
        };
        lanes.set(key, lane);
      }
      const list = lane.cardsByBucket.get(bucket.id) ?? [];
      list.push(card);
      lane.cardsByBucket.set(bucket.id, list);
    }
  }
  return Array.from(lanes.values()).sort((a, b) => {
    if (a.key === UNASSIGNED_LANE_KEY) return 1;
    if (b.key === UNASSIGNED_LANE_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}

// Never fires — swimlane cards can't be dragged (grouping view, not a drop
// target; see the module doc on KanbanJiraBoard) but press/dispatch still
// work via KanbanJiraBoard's own detail/dispatch state.
function noop(): void {
  // Intentionally empty.
}

/**
 * Jira source-kind view: lanes are the ticket's REAL Jira status (e.g.
 * "Pending Code Review", "In Development"), not Paseo's generic
 * pending/wip/done buckets — see buildJiraBuckets. When the host supports
 * kanbanWriteBack, dragging a card between lanes fires a real Jira
 * transition (see kanban-status-board.tsx's writeBack contract) instead of
 * staying disabled; the detail sheet's comment/transition controls are
 * separate (kanban-card-detail-sheet.tsx).
 *
 * Quick filters (Unassigned / High priority) narrow `cards` before bucketing
 * — client-side only, no new metadata needed. "Group by assignee" swaps the
 * flat board for a cross-column swimlane grid; that view is read-only (press
 * still opens detail, but no drag/long-press) — swimlane cells don't have a
 * 1:1 column-bounds mapping the write-back drag system can hit-test against,
 * so building real drag support for it is deferred rather than shipping a
 * dishonest partial one.
 */
export function KanbanJiraBoard({
  cards,
  serverId,
  cardDetailSupported,
  mutations,
  sources,
}: KanbanBoardProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const writeBackSupported = useHostFeature(serverId, "kanbanWriteBack");
  const sourceStatusesSupported = useHostFeature(serverId, "kanbanSourceStatuses");
  // Cards only carry source.kind, not a specific sourceId (see
  // kanban-screen.tsx's KanbanBoardTab doc) — with several Jira sources
  // configured, the first one stands in for "the" Jira workflow.
  const jiraSourceId = useMemo(
    () => sources.find((source) => source.kind === "jira")?.id ?? null,
    [sources],
  );
  const { statuses: fullStatuses } = useKanbanSourceStatuses(
    serverId,
    jiraSourceId,
    sourceStatusesSupported,
  );
  const writeback = useKanbanWriteback({ serverId: serverId ?? "" });

  const categoryByName = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const status of fullStatuses ?? []) {
      map.set(status.name, status.category);
    }
    return map;
  }, [fullStatuses]);

  // Quick filters: board-local toggles, not the removed global filter bar —
  // scoped to data already on the card (assignee/priority), no new RPCs.
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [highPriorityOnly, setHighPriorityOnly] = useState(false);
  const [groupByAssignee, setGroupByAssignee] = useState(false);
  const toggleUnassignedOnly = useCallback(() => setUnassignedOnly((current) => !current), []);
  const toggleHighPriorityOnly = useCallback(() => setHighPriorityOnly((current) => !current), []);
  const toggleGroupByAssignee = useCallback(() => setGroupByAssignee((current) => !current), []);

  const filteredCards = useMemo(() => {
    let result = cards;
    if (unassignedOnly) {
      result = result.filter((card) => !card.assignee);
    }
    if (highPriorityOnly) {
      result = result.filter((card) => card.priority === "high");
    }
    return result;
  }, [cards, unassignedOnly, highPriorityOnly]);

  const buckets = useMemo(
    () => buildJiraBuckets(filteredCards, fullStatuses, t),
    [filteredCards, fullStatuses, t],
  );
  const swimlanes = useMemo(
    () => (groupByAssignee ? buildJiraSwimlanes(buckets, t) : null),
    [groupByAssignee, buckets, t],
  );

  // Drag write-back state: which card is dragging and its live transitions
  // (null = fetch in flight, so the board doesn't dim every lane before it
  // knows which ones are legal).
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [draggingTransitions, setDraggingTransitions] = useState<KanbanCardTransition[] | null>(
    null,
  );

  const legalBucketIds = useMemo(() => {
    if (!draggingCardId) {
      return undefined;
    }
    if (!draggingTransitions) {
      return null;
    }
    const legalNames = new Set(
      draggingTransitions.map((transition) => transition.toStatusName).filter(Boolean),
    );
    return new Set(
      buckets.filter((bucket) => legalNames.has(bucket.title)).map((bucket) => bucket.id),
    );
  }, [draggingCardId, draggingTransitions, buckets]);

  const runTransition = useCallback(
    (cardId: string, transition: KanbanCardTransition) => {
      const categoryKey = transition.toStatusName
        ? (categoryByName.get(transition.toStatusName) ?? null)
        : null;
      void writeback.transitionCard({ cardId, transition, categoryKey }).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [categoryByName, toast, writeback],
  );

  const handleDragStart = useCallback(
    (cardId: string) => {
      setDraggingCardId(cardId);
      setDraggingTransitions(null);
      void writeback
        .listTransitions(cardId)
        .then(setDraggingTransitions)
        .catch(() => setDraggingTransitions([]));
    },
    [writeback],
  );
  const handleDragEnd = useCallback(() => {
    setDraggingCardId(null);
    setDraggingTransitions(null);
  }, []);
  const handleDrop = useCallback(
    ({ cardId, toBucketId }: { cardId: string; fromBucketId: string; toBucketId: string }) => {
      const targetBucket = buckets.find((bucket) => bucket.id === toBucketId);
      const transition = draggingTransitions?.find(
        (candidate) => candidate.toStatusName === targetBucket?.title,
      );
      // No matching transition (illegal lane, or transitions still loading
      // when the drop lands) — silently no-op, the card snaps back visually
      // since nothing was optimistically moved.
      if (!transition) {
        return;
      }
      runTransition(cardId, transition);
    },
    [buckets, draggingTransitions, runTransition],
  );

  const [transitionPickerCard, setTransitionPickerCard] = useState<StoredKanbanCard | null>(null);
  const [pickerTransitions, setPickerTransitions] = useState<KanbanCardTransition[] | null>(null);
  const [pickerError, setPickerError] = useState(false);
  const handleLongPress = useCallback(
    (card: StoredKanbanCard) => {
      setTransitionPickerCard(card);
      setPickerTransitions(null);
      setPickerError(false);
      void writeback
        .listTransitions(card.id)
        .then(setPickerTransitions)
        .catch(() => setPickerError(true));
    },
    [writeback],
  );
  const closeTransitionPicker = useCallback(() => setTransitionPickerCard(null), []);
  const handlePickTransition = useCallback(
    (transition: KanbanCardTransition) => {
      if (!transitionPickerCard) {
        return;
      }
      runTransition(transitionPickerCard.id, transition);
    },
    [runTransition, transitionPickerCard],
  );

  // Swimlane view has no equivalent of KanbanStatusBoard's own internal
  // detail/dispatch/edit sheet state (that component isn't rendered while
  // swimlanes are active), so it gets its own copy here — same shape,
  // mutually exclusive with the flat board's.
  const [swimlaneDetailCard, setSwimlaneDetailCard] = useState<StoredKanbanCard | null>(null);
  const [swimlaneDispatchCard, setSwimlaneDispatchCard] = useState<StoredKanbanCard | null>(null);
  const [swimlaneEditCard, setSwimlaneEditCard] = useState<StoredKanbanCard | null>(null);
  const handleSwimlaneCardPress = useCallback((card: StoredKanbanCard) => {
    setSwimlaneDetailCard(card);
  }, []);
  const handleSwimlaneCardDispatch = useCallback((card: StoredKanbanCard) => {
    setSwimlaneDispatchCard(card);
  }, []);
  const closeSwimlaneDetail = useCallback(() => setSwimlaneDetailCard(null), []);
  const closeSwimlaneDispatch = useCallback(() => setSwimlaneDispatchCard(null), []);
  const closeSwimlaneEdit = useCallback(() => setSwimlaneEditCard(null), []);
  const handleSwimlaneEditFromDetail = useCallback(() => {
    setSwimlaneEditCard(swimlaneDetailCard);
    setSwimlaneDetailCard(null);
  }, [swimlaneDetailCard]);
  const handleSwimlaneDispatchFromDetail = useCallback(() => {
    setSwimlaneDispatchCard(swimlaneDetailCard);
    setSwimlaneDetailCard(null);
  }, [swimlaneDetailCard]);

  const writeBack = useMemo(
    () =>
      writeBackSupported
        ? {
            onDragStart: handleDragStart,
            onDragEnd: handleDragEnd,
            legalBucketIds,
            onDrop: handleDrop,
            onLongPress: handleLongPress,
          }
        : undefined,
    [
      writeBackSupported,
      handleDragStart,
      handleDragEnd,
      legalBucketIds,
      handleDrop,
      handleLongPress,
    ],
  );

  return (
    <>
      <View style={styles.quickFilters} testID="kanban-jira-quick-filters">
        <Button
          size="sm"
          variant={unassignedOnly ? "secondary" : "ghost"}
          onPress={toggleUnassignedOnly}
          testID="kanban-jira-quick-filter-unassigned"
        >
          {t("kanban.filters.assignee.unassigned")}
        </Button>
        <Button
          size="sm"
          variant={highPriorityOnly ? "secondary" : "ghost"}
          onPress={toggleHighPriorityOnly}
          testID="kanban-jira-quick-filter-high-priority"
        >
          {t("kanban.jira.highPriority")}
        </Button>
        <Button
          size="sm"
          variant={groupByAssignee ? "secondary" : "ghost"}
          onPress={toggleGroupByAssignee}
          testID="kanban-jira-quick-filter-group-by-assignee"
        >
          {t("kanban.jira.groupByAssignee")}
        </Button>
      </View>
      {swimlanes ? (
        <>
          <KanbanJiraSwimlaneGrid
            buckets={buckets}
            swimlanes={swimlanes}
            onCardPress={handleSwimlaneCardPress}
            onCardDispatch={handleSwimlaneCardDispatch}
          />
          <KanbanCardDetailSheet
            key={swimlaneDetailCard ? `detail:${swimlaneDetailCard.id}` : "detail:none"}
            visible={swimlaneDetailCard !== null}
            card={swimlaneDetailCard}
            serverId={serverId}
            detailSupported={cardDetailSupported}
            onClose={closeSwimlaneDetail}
            onEdit={handleSwimlaneEditFromDetail}
            onDispatch={handleSwimlaneDispatchFromDetail}
          />
          <KanbanCardDispatchSheet
            key={swimlaneDispatchCard ? `dispatch:${swimlaneDispatchCard.id}` : "dispatch:none"}
            visible={swimlaneDispatchCard !== null}
            card={swimlaneDispatchCard}
            serverId={serverId}
            onClose={closeSwimlaneDispatch}
          />
          <KanbanCardSheet
            key={swimlaneEditCard ? `edit:${swimlaneEditCard.id}` : "edit:none"}
            visible={swimlaneEditCard !== null}
            mode="edit"
            card={swimlaneEditCard ?? undefined}
            onClose={closeSwimlaneEdit}
            onCreate={mutations.createCard}
            onUpdate={mutations.updateCard}
            onDelete={mutations.deleteCard}
          />
        </>
      ) : (
        <KanbanStatusBoard
          buckets={buckets}
          serverId={serverId}
          cardDetailSupported={cardDetailSupported}
          mutations={mutations}
          writeBack={writeBack}
        />
      )}
      {writeBackSupported ? (
        <KanbanTransitionPickerSheet
          visible={transitionPickerCard !== null}
          transitions={pickerTransitions}
          isLoading={pickerTransitions === null && !pickerError}
          isError={pickerError}
          onSelect={handlePickTransition}
          onClose={closeTransitionPicker}
        />
      ) : null}
    </>
  );
}

// Cross-column swimlane matrix: one sticky-ish header row of status titles,
// then one row per assignee. The whole grid (header included) lives inside a
// single horizontal ScrollView so the header and every row scroll in lockstep
// without needing manual scroll-position syncing.
function KanbanJiraSwimlaneGrid({
  buckets,
  swimlanes,
  onCardPress,
  onCardDispatch,
}: {
  buckets: KanbanStatusBucket[];
  swimlanes: JiraSwimlane[];
  onCardPress: (card: StoredKanbanCard) => void;
  onCardDispatch: (card: StoredKanbanCard) => void;
}): ReactElement {
  return (
    <ScrollView horizontal style={styles.swimlaneScroll} testID="kanban-jira-swimlanes">
      <View>
        <View style={styles.swimlaneRow}>
          <View style={styles.swimlaneLabel} />
          {buckets.map((bucket) => (
            <View key={bucket.id} style={styles.swimlaneHeaderCell}>
              <Text style={styles.swimlaneHeaderText} numberOfLines={1}>
                {bucket.title}
              </Text>
            </View>
          ))}
        </View>
        {swimlanes.map((lane) => (
          <View key={lane.key} style={styles.swimlaneRow}>
            <View style={styles.swimlaneLabel}>
              <Text style={styles.swimlaneLabelText} numberOfLines={1}>
                {lane.label}
              </Text>
            </View>
            {buckets.map((bucket) => (
              <View key={bucket.id} style={styles.swimlaneCell}>
                {(lane.cardsByBucket.get(bucket.id) ?? []).map((card) => (
                  <KanbanCard
                    key={card.id}
                    card={card}
                    columnId={bucket.id}
                    onPress={onCardPress}
                    onLongPress={noop}
                    onDispatch={onCardDispatch}
                    onDragBegin={noop}
                    onDragStart={noop}
                    onDragUpdate={noop}
                    onDragEnd={noop}
                    onDrop={noop}
                    dragEnabled={false}
                  />
                ))}
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  quickFilters: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[3],
  },
  swimlaneScroll: {
    flex: 1,
  },
  swimlaneRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  swimlaneLabel: {
    width: SWIMLANE_LABEL_WIDTH,
    flexShrink: 0,
    justifyContent: "center",
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  swimlaneLabelText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  swimlaneHeaderCell: {
    width: SWIMLANE_COLUMN_WIDTH,
    flexShrink: 0,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  swimlaneHeaderText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  swimlaneCell: {
    width: SWIMLANE_COLUMN_WIDTH,
    flexShrink: 0,
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
}));
