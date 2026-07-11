import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  KANBAN_STATUS_ORDER,
  type KanbanStatus,
  type StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import { KanbanColumn, type KanbanColumnBounds } from "@/components/kanban/kanban-column";
import { KanbanCardSheet } from "@/components/kanban/kanban-card-sheet";
import { KanbanStatusPickerSheet } from "@/components/kanban/kanban-status-picker-sheet";
import type { KanbanCardDropHandler } from "@/components/kanban/kanban-card";
import { isWeb } from "@/constants/platform";
import type { UseKanbanMutationsResult } from "@/hooks/use-kanban-mutations";

interface KanbanBoardProps {
  cards: StoredKanbanCard[];
  mutations: UseKanbanMutationsResult;
}

// Stable empty reference so a card-less column doesn't create a new array on
// every render (react-perf/jsx-no-new-array-as-prop).
const EMPTY_COLUMN_CARDS: StoredKanbanCard[] = [];

/**
 * The six-column board. Owns the card detail sheet and the status picker, plus
 * the web pointer-drag drop resolution: columns report their window bounds and
 * a drop's x (corrected for horizontal scroll) is hit-tested against them.
 */
export function KanbanBoard({ cards, mutations }: KanbanBoardProps): ReactElement {
  const { t } = useTranslation();
  const dragEnabled = isWeb;

  const columnBoundsRef = useRef<Map<KanbanStatus, KanbanColumnBounds>>(new Map());
  const columnRefs = useRef<Map<KanbanStatus, View>>(new Map());

  const [detailCard, setDetailCard] = useState<StoredKanbanCard | null>(null);
  const [pickerCard, setPickerCard] = useState<StoredKanbanCard | null>(null);
  // Which column a card is being dragged FROM (raised above siblings) and which
  // column the drag is hovering OVER (drop highlight). Web-only.
  const [draggingStatus, setDraggingStatus] = useState<KanbanStatus | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<KanbanStatus | null>(null);

  const cardsByStatus = useMemo(() => {
    const groups = new Map<KanbanStatus, StoredKanbanCard[]>();
    for (const status of KANBAN_STATUS_ORDER) {
      groups.set(status, []);
    }
    for (const card of cards) {
      groups.get(card.status)?.push(card);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.order - b.order);
    }
    return groups;
  }, [cards]);

  const registerColumnRef = useCallback((status: KanbanStatus, node: View | null) => {
    if (node) {
      columnRefs.current.set(status, node);
    } else {
      columnRefs.current.delete(status);
    }
  }, []);

  // Re-measure every column in window coordinates at the moment a drag begins.
  // No scroll happens during a drag, so these bounds stay valid until drop, and
  // the drop's absoluteX (also window coords) is compared directly — no scroll
  // correction, so nothing can double-count the offset.
  const measureColumns = useCallback(() => {
    for (const [status, node] of columnRefs.current) {
      node.measureInWindow((x, _y, width) => {
        columnBoundsRef.current.set(status, { x, width });
      });
    }
  }, []);

  const resolveDropStatus = useCallback((absoluteX: number): KanbanStatus | null => {
    for (const [status, bounds] of columnBoundsRef.current) {
      if (absoluteX >= bounds.x && absoluteX <= bounds.x + bounds.width) {
        return status;
      }
    }
    return null;
  }, []);

  const handleCardDragStart = useCallback((status: KanbanStatus) => {
    setDraggingStatus(status);
  }, []);

  const handleCardDragUpdate = useCallback(
    (absoluteX: number) => {
      const target = resolveDropStatus(absoluteX);
      // Only re-render when the hovered column actually changes.
      setDropTargetStatus((current) => (current === target ? current : target));
    },
    [resolveDropStatus],
  );

  const handleCardDragEnd = useCallback(() => {
    setDraggingStatus(null);
    setDropTargetStatus(null);
  }, []);

  const handleCardDrop = useCallback<KanbanCardDropHandler>(
    ({ cardId, fromStatus, absoluteX }) => {
      const target = resolveDropStatus(absoluteX);
      if (!target || target === fromStatus) {
        return;
      }
      void mutations.moveCard({ id: cardId, status: target });
    },
    [mutations, resolveDropStatus],
  );

  const handleCardPress = useCallback((card: StoredKanbanCard) => {
    setDetailCard(card);
  }, []);

  const handleCardLongPress = useCallback((card: StoredKanbanCard) => {
    setPickerCard(card);
  }, []);

  const handlePickStatus = useCallback(
    (status: KanbanStatus) => {
      if (pickerCard && pickerCard.status !== status) {
        void mutations.moveCard({ id: pickerCard.id, status });
      }
    },
    [mutations, pickerCard],
  );

  const closeDetail = useCallback(() => setDetailCard(null), []);
  const closePicker = useCallback(() => setPickerCard(null), []);

  return (
    <>
      <ScrollView
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsHorizontalScrollIndicator={false}
        testID="kanban-board"
      >
        {KANBAN_STATUS_ORDER.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            label={t(`kanban.columns.${status}`)}
            cards={cardsByStatus.get(status) ?? EMPTY_COLUMN_CARDS}
            isDragging={draggingStatus === status}
            isDropTarget={dropTargetStatus === status && draggingStatus !== status}
            onRegisterRef={registerColumnRef}
            onCardDragBegin={measureColumns}
            onCardDragStart={handleCardDragStart}
            onCardDragUpdate={handleCardDragUpdate}
            onCardDragEnd={handleCardDragEnd}
            onCardPress={handleCardPress}
            onCardLongPress={handleCardLongPress}
            onCardDrop={handleCardDrop}
            dragEnabled={dragEnabled}
          />
        ))}
      </ScrollView>

      <KanbanCardSheet
        key={detailCard ? `edit:${detailCard.id}` : "edit:none"}
        visible={detailCard !== null}
        mode="edit"
        card={detailCard ?? undefined}
        onClose={closeDetail}
        onCreate={mutations.createCard}
        onUpdate={mutations.updateCard}
        onDelete={mutations.deleteCard}
      />

      <KanbanStatusPickerSheet
        visible={pickerCard !== null}
        currentStatus={pickerCard?.status}
        onSelect={handlePickStatus}
        onClose={closePicker}
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
    // Fill the board height so columns stretch into full-height lanes, and grow
    // to at least the viewport so short boards still show tall drop zones.
    minHeight: "100%",
    flexGrow: 1,
    alignItems: "stretch",
  },
}));
