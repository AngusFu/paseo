import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { ScrollView, type View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  KanbanColumn as KanbanColumnData,
  StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import { KanbanColumn, type KanbanColumnBounds } from "@/components/kanban/kanban-column";
import type { KanbanCardDropHandler } from "@/components/kanban/kanban-card";
import { KanbanCardDetailSheet } from "@/components/kanban/kanban-card-detail-sheet";
import { KanbanCardDispatchSheet } from "@/components/kanban/kanban-card-dispatch-sheet";
import { KanbanCardSheet } from "@/components/kanban/kanban-card-sheet";
import { isWeb } from "@/constants/platform";
import type { UseKanbanMutationsResult } from "@/hooks/use-kanban-mutations";

// A read-only lane: one real tracker status (Jira status name / GitLab MR
// bucket), not a configurable Paseo column. `id` only needs to be stable
// across renders for React's key — it is never sent to the server.
export interface KanbanStatusBucket {
  id: string;
  title: string;
  cards: StoredKanbanCard[];
}

// Write-back drag wiring (Jira only, gated by the kanbanWriteBack capability
// upstream in kanban-jira-board.tsx). Omit entirely to keep dragging and the
// native long-press status change fully disabled — see the module doc below.
export interface KanbanStatusBoardWriteBack {
  /** Pan activated on a card — kick off the transitions fetch here. */
  onDragStart: (cardId: string, fromBucketId: string) => void;
  onDragEnd: () => void;
  /** Bucket ids the currently-dragging card can legally move to (matched by
   * the caller from the fetched transitions' toStatusName). `null` = fetch
   * still in flight (no dimming yet); `undefined` = nothing dragging. */
  legalBucketIds: Set<string> | null | undefined;
  onDrop: (params: { cardId: string; fromBucketId: string; toBucketId: string }) => void;
  /** Native long-press — opens the transition picker instead of the
   * (removed) generic status picker. */
  onLongPress: (card: StoredKanbanCard) => void;
}

export interface KanbanStatusBoardProps {
  buckets: KanbanStatusBucket[];
  serverId: string | null;
  cardDetailSupported: boolean;
  mutations: UseKanbanMutationsResult;
  writeBack?: KanbanStatusBoardWriteBack;
}

// Never fires — the stand-in for every drag-related KanbanColumn callback
// when write-back isn't wired (GitLab board, or Jira without the capability).
function noop(): void {
  // Intentionally empty.
}

/**
 * Shared board for source-kind views backed by the tracker's OWN status set
 * (Jira status name, GitLab MR state) instead of Paseo's configurable columns
 * — see kanban-jira-board.tsx / kanban-gitlab-board.tsx, which compute
 * `buckets` from card metadata and render this.
 *
 * Dragging is off by default: a real status change here means calling the
 * tracker's transition API. Reshuffling the card into a generic Paseo bucket
 * instead of really transitioning the ticket would be worse than no drag at
 * all ("禁拖比假拖诚实"). Pass `writeBack` (Jira + kanbanWriteBack capability
 * only) to enable it for real — dragging then only ever resolves to a legal
 * Jira transition, and the caller (not this component) makes the actual RPC
 * call, with optimistic-move/rollback and error toasting on its side. Only
 * column-level (X-axis) hit-testing is needed here — unlike the free-form
 * generic board, a tracker status doesn't have an in-lane card order to
 * preserve, so there's no Y/card-bounds measurement at all.
 */
export function KanbanStatusBoard({
  buckets,
  serverId,
  cardDetailSupported,
  mutations,
  writeBack,
}: KanbanStatusBoardProps): ReactElement {
  const dragEnabled = isWeb && Boolean(writeBack);

  const columnRefs = useRef<Map<string, View>>(new Map());
  const columnBoundsRef = useRef<Map<string, KanbanColumnBounds>>(new Map());
  const [draggingBucketId, setDraggingBucketId] = useState<string | null>(null);
  const [dropTargetBucketId, setDropTargetBucketId] = useState<string | null>(null);

  const [detailCard, setDetailCard] = useState<StoredKanbanCard | null>(null);
  const [dispatchCard, setDispatchCard] = useState<StoredKanbanCard | null>(null);
  const [editCard, setEditCard] = useState<StoredKanbanCard | null>(null);

  const registerColumnRef = useCallback((bucketId: string, node: View | null) => {
    if (node) {
      columnRefs.current.set(bucketId, node);
    } else {
      columnRefs.current.delete(bucketId);
    }
  }, []);

  const measureColumns = useCallback(() => {
    for (const [bucketId, node] of columnRefs.current) {
      node.measureInWindow((x, _y, width) => {
        columnBoundsRef.current.set(bucketId, { x, width });
      });
    }
  }, []);

  const resolveDropBucketId = useCallback((absoluteX: number): string | null => {
    for (const [bucketId, bounds] of columnBoundsRef.current) {
      if (absoluteX >= bounds.x && absoluteX <= bounds.x + bounds.width) {
        return bucketId;
      }
    }
    return null;
  }, []);

  const handleCardDragStart = useCallback(
    (bucketId: string, cardId: string) => {
      setDraggingBucketId(bucketId);
      writeBack?.onDragStart(cardId, bucketId);
    },
    [writeBack],
  );

  const handleCardDragUpdate = useCallback(
    (absoluteX: number) => {
      const target = resolveDropBucketId(absoluteX);
      setDropTargetBucketId((current) => (current === target ? current : target));
    },
    [resolveDropBucketId],
  );

  const handleCardDragEnd = useCallback(() => {
    setDraggingBucketId(null);
    setDropTargetBucketId(null);
    writeBack?.onDragEnd();
  }, [writeBack]);

  const handleCardPress = useCallback((card: StoredKanbanCard) => setDetailCard(card), []);
  const handleCardDispatch = useCallback((card: StoredKanbanCard) => setDispatchCard(card), []);
  const closeDetail = useCallback(() => setDetailCard(null), []);
  const closeDispatch = useCallback(() => setDispatchCard(null), []);
  const handleEditFromDetail = useCallback(() => {
    setEditCard(detailCard);
    setDetailCard(null);
  }, [detailCard]);
  const handleDispatchFromDetail = useCallback(() => {
    setDispatchCard(detailCard);
    setDetailCard(null);
  }, [detailCard]);
  const closeEdit = useCallback(() => setEditCard(null), []);
  const handleCardLongPress = useCallback(
    (card: StoredKanbanCard) => writeBack?.onLongPress(card),
    [writeBack],
  );

  const handleCardDrop = useCallback<KanbanCardDropHandler>(
    (params) => {
      if (!writeBack) {
        return;
      }
      const toBucketId = resolveDropBucketId(params.absoluteX);
      if (!toBucketId || toBucketId === params.fromColumnId) {
        return;
      }
      writeBack.onDrop({
        cardId: params.cardId,
        fromBucketId: params.fromColumnId,
        toBucketId,
      });
    },
    [resolveDropBucketId, writeBack],
  );

  // KanbanColumn wants a real KanbanColumnData — built once per bucket list
  // (not inlined in JSX) so the prop object stays referentially stable.
  const columns = useMemo<Array<{ bucket: KanbanStatusBucket; column: KanbanColumnData }>>(
    () =>
      buckets.map((bucket) => ({
        bucket,
        column: {
          id: bucket.id,
          title: bucket.title,
          order: 0,
          hidden: false,
          legacyStatus: "pending",
        },
      })),
    [buckets],
  );

  return (
    <>
      <ScrollView
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsHorizontalScrollIndicator={false}
        testID="kanban-status-board"
      >
        {columns.map(({ bucket, column }) => {
          const isDropTarget = dropTargetBucketId === bucket.id && draggingBucketId !== bucket.id;
          const dimmed = Boolean(
            writeBack &&
            draggingBucketId !== null &&
            draggingBucketId !== bucket.id &&
            writeBack.legalBucketIds &&
            !writeBack.legalBucketIds.has(bucket.id),
          );
          return (
            <KanbanColumn
              key={bucket.id}
              column={column}
              cards={bucket.cards}
              isDragging={draggingBucketId === bucket.id}
              isDropTarget={isDropTarget}
              dimmed={dimmed}
              onRegisterRef={registerColumnRef}
              onRegisterCardRef={noop}
              onCardDragBegin={measureColumns}
              onCardDragStart={handleCardDragStart}
              onCardDragUpdate={handleCardDragUpdate}
              onCardDragEnd={handleCardDragEnd}
              onCardPress={handleCardPress}
              onCardLongPress={handleCardLongPress}
              onCardDispatch={handleCardDispatch}
              onCardDrop={handleCardDrop}
              dragEnabled={dragEnabled}
            />
          );
        })}
      </ScrollView>

      <KanbanCardDetailSheet
        key={detailCard ? `detail:${detailCard.id}` : "detail:none"}
        visible={detailCard !== null}
        card={detailCard}
        serverId={serverId}
        detailSupported={cardDetailSupported}
        onClose={closeDetail}
        onEdit={handleEditFromDetail}
        onDispatch={handleDispatchFromDetail}
      />

      <KanbanCardDispatchSheet
        key={dispatchCard ? `dispatch:${dispatchCard.id}` : "dispatch:none"}
        visible={dispatchCard !== null}
        card={dispatchCard}
        serverId={serverId}
        onClose={closeDispatch}
      />

      <KanbanCardSheet
        key={editCard ? `edit:${editCard.id}` : "edit:none"}
        visible={editCard !== null}
        mode="edit"
        card={editCard ?? undefined}
        onClose={closeEdit}
        onCreate={mutations.createCard}
        onUpdate={mutations.updateCard}
        onDelete={mutations.deleteCard}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[4],
    minHeight: "100%",
    flexGrow: 1,
    alignItems: "stretch",
  },
}));
