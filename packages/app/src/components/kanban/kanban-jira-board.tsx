import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  KanbanCardTransition,
  KanbanExternalStatus,
  StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import type { KanbanBoardProps } from "@/components/kanban/kanban-board";
import {
  KanbanStatusBoard,
  type KanbanStatusBucket,
} from "@/components/kanban/kanban-status-board";
import { KanbanTransitionPickerSheet } from "@/components/kanban/kanban-transition-picker-sheet";
import { useToast } from "@/contexts/toast-context";
import { useKanbanSourceStatuses } from "@/hooks/use-kanban-source-statuses";
import { useKanbanWriteback } from "@/hooks/use-kanban-writeback";
import { useHostFeature } from "@/runtime/host-features";

// Jira's own statusCategory bucket (todo/in-progress/done), used only to
// ORDER the lanes left-to-right — the lane itself is still one per exact
// status name, never collapsed into the three categories.
const CATEGORY_ORDER: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
const UNKNOWN_CATEGORY_ORDER = 3;

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
    for (const status of fullStatuses) {
      byKey.set(status.name, {
        title: status.name,
        order: categoryOrder(status.category),
        cards: [],
      });
    }
  }
  for (const card of cards) {
    const status = readJiraStatus(card.metadata);
    const key = status?.name ?? `legacy:${card.status}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        title: status?.name ?? t(`kanban.columns.${card.status}`),
        order: status?.order ?? UNKNOWN_CATEGORY_ORDER,
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

/**
 * Jira source-kind view: lanes are the ticket's REAL Jira status (e.g.
 * "Pending Code Review", "In Development"), not Paseo's generic
 * pending/wip/done buckets — see buildJiraBuckets. When the host supports
 * kanbanWriteBack, dragging a card between lanes fires a real Jira
 * transition (see kanban-status-board.tsx's writeBack contract) instead of
 * staying disabled; the detail sheet's comment/transition controls are
 * separate (kanban-card-detail-sheet.tsx).
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

  const buckets = useMemo(() => buildJiraBuckets(cards, fullStatuses, t), [cards, fullStatuses, t]);

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
      <KanbanStatusBoard
        buckets={buckets}
        serverId={serverId}
        cardDetailSupported={cardDetailSupported}
        mutations={mutations}
        writeBack={writeBack}
      />
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
