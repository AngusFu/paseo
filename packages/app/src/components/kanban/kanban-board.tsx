import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  KanbanColumn as KanbanColumnData,
  StoredKanbanCard,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { KanbanColumn, type KanbanColumnBounds } from "@/components/kanban/kanban-column";
import { KanbanAddColumn } from "@/components/kanban/kanban-add-column";
import { KanbanCardDetailSheet } from "@/components/kanban/kanban-card-detail-sheet";
import { KanbanCardDispatchSheet } from "@/components/kanban/kanban-card-dispatch-sheet";
import { KanbanCardSheet } from "@/components/kanban/kanban-card-sheet";
import { KanbanColumnDeleteSheet } from "@/components/kanban/kanban-column-delete-sheet";
import { KanbanColumnRenameSheet } from "@/components/kanban/kanban-column-rename-sheet";
import { KanbanStatusPickerSheet } from "@/components/kanban/kanban-status-picker-sheet";
import type { KanbanCardDropHandler } from "@/components/kanban/kanban-card";
import { isWeb } from "@/constants/platform";
import type { UseKanbanColumnMutationsResult } from "@/hooks/use-kanban-column-mutations";
import type { UseKanbanMutationsResult } from "@/hooks/use-kanban-mutations";

export interface KanbanBoardProps {
  cards: StoredKanbanCard[];
  columns: KanbanColumnData[];
  columnsSupported: boolean;
  serverId: string | null;
  cardDetailSupported: boolean;
  mutations: UseKanbanMutationsResult;
  columnMutations: UseKanbanColumnMutationsResult;
  // All configured sources — most registered views (this generic board)
  // ignore it; the Jira view uses it to resolve which source's statuses to
  // fetch for the full-column-mapping / write-back capability checks.
  sources: StoredKanbanSource[];
}

// Stable empty reference so a card-less column doesn't create a new array on
// every render (react-perf/jsx-no-new-array-as-prop).
const EMPTY_COLUMN_CARDS: StoredKanbanCard[] = [];

// Resolves which column a card belongs to. `columnId` wins when it matches a
// visible column. Cards without a matching columnId (legacy cards, or a
// columnId pointing at a hidden/deleted column) fall back to the column whose
// legacyStatus matches the card's status; skip/fail/abort cards additionally
// fall back to the "done" column when no exact legacyStatus match exists.
// A card that still can't resolve lands in the first column.
export function resolveCardColumn(
  card: StoredKanbanCard,
  columns: KanbanColumnData[],
): KanbanColumnData | null {
  if (card.columnId) {
    const direct = columns.find((column) => column.id === card.columnId);
    if (direct) {
      return direct;
    }
  }
  const byStatus = columns.find((column) => column.legacyStatus === card.status);
  if (byStatus) {
    return byStatus;
  }
  if (card.status === "skip" || card.status === "fail" || card.status === "abort") {
    const done = columns.find((column) => column.legacyStatus === "done");
    if (done) {
      return done;
    }
  }
  return columns[0] ?? null;
}

/**
 * The board: a horizontally-scrolling row of user-configurable columns. Owns
 * the card detail sheet, the status picker, column management (rename/hide/
 * reorder/delete/add), and the web pointer-drag drop resolution: columns
 * report their window bounds and a drop's x (corrected for horizontal scroll)
 * is hit-tested against them.
 */
export function KanbanBoard({
  cards,
  columns,
  columnsSupported,
  serverId,
  cardDetailSupported,
  mutations,
  columnMutations,
}: KanbanBoardProps): ReactElement {
  const dragEnabled = isWeb;

  const columnBoundsRef = useRef<Map<string, KanbanColumnBounds>>(new Map());
  const columnRefs = useRef<Map<string, View>>(new Map());
  // Per-card window Y bounds, measured alongside column bounds at drag begin
  // (see measureColumns) and used to compute an in-column insert position.
  const cardBoundsRef = useRef<Map<string, { y: number; height: number }>>(new Map());
  const cardRefs = useRef<Map<string, View>>(new Map());

  // Tapping a card opens the read-only detail sheet; its Edit action hands off
  // to the existing edit-form sheet below.
  const [detailCard, setDetailCard] = useState<StoredKanbanCard | null>(null);
  const [dispatchCard, setDispatchCard] = useState<StoredKanbanCard | null>(null);
  const [editCard, setEditCard] = useState<StoredKanbanCard | null>(null);
  const [pickerCard, setPickerCard] = useState<StoredKanbanCard | null>(null);
  const [renameTarget, setRenameTarget] = useState<KanbanColumnData | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KanbanColumnData | null>(null);
  // Which column a card is being dragged FROM (raised above siblings) and which
  // column the drag is hovering OVER (drop highlight). Web-only.
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);
  const [dropTargetColumnId, setDropTargetColumnId] = useState<string | null>(null);

  const cardsByColumn = useMemo(() => {
    const groups = new Map<string, StoredKanbanCard[]>();
    for (const column of columns) {
      groups.set(column.id, []);
    }
    for (const card of cards) {
      const column = resolveCardColumn(card, columns);
      if (!column) {
        continue;
      }
      groups.get(column.id)?.push(card);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.order - b.order);
    }
    return groups;
  }, [cards, columns]);

  const registerColumnRef = useCallback((columnId: string, node: View | null) => {
    if (node) {
      columnRefs.current.set(columnId, node);
    } else {
      columnRefs.current.delete(columnId);
    }
  }, []);

  const registerCardRef = useCallback((cardId: string, node: View | null) => {
    if (node) {
      cardRefs.current.set(cardId, node);
    } else {
      cardRefs.current.delete(cardId);
    }
  }, []);

  // Re-measure every column AND card in window coordinates at the moment a
  // drag begins. No scroll happens during a drag, so these bounds stay valid
  // until drop, and the drop's absoluteX/absoluteY (also window coords) are
  // compared directly — no scroll correction, so nothing can double-count the
  // offset.
  const measureColumns = useCallback(() => {
    for (const [columnId, node] of columnRefs.current) {
      node.measureInWindow((x, _y, width) => {
        columnBoundsRef.current.set(columnId, { x, width });
      });
    }
    for (const [cardId, node] of cardRefs.current) {
      node.measureInWindow((_x, y, _width, height) => {
        cardBoundsRef.current.set(cardId, { y, height });
      });
    }
  }, []);

  const resolveDropColumnId = useCallback((absoluteX: number): string | null => {
    for (const [columnId, bounds] of columnBoundsRef.current) {
      if (absoluteX >= bounds.x && absoluteX <= bounds.x + bounds.width) {
        return columnId;
      }
    }
    return null;
  }, []);

  // Insert position within the target column, from the drop's Y coordinate:
  // finds the first sibling (in current order, dragged card excluded) whose
  // vertical midpoint sits below the drop point, and returns a float order
  // between it and its predecessor (server column-order semantics — see
  // docs/kanban.md). Returns undefined when there's nothing to order against
  // (empty column, or dropping the only card in its own column) — the server
  // then appends as before.
  const computeDropOrder = useCallback(
    (columnId: string, cardId: string, absoluteY: number): number | undefined => {
      const siblings = (cardsByColumn.get(columnId) ?? []).filter((card) => card.id !== cardId);
      if (siblings.length === 0) {
        return undefined;
      }
      let insertIndex = siblings.length;
      for (let i = 0; i < siblings.length; i++) {
        const bounds = cardBoundsRef.current.get(siblings[i].id);
        if (!bounds) {
          continue;
        }
        if (absoluteY < bounds.y + bounds.height / 2) {
          insertIndex = i;
          break;
        }
      }
      const prevOrder = insertIndex > 0 ? siblings[insertIndex - 1].order : undefined;
      const nextOrder = insertIndex < siblings.length ? siblings[insertIndex].order : undefined;
      if (prevOrder === undefined) {
        return nextOrder !== undefined ? nextOrder - 1 : undefined;
      }
      if (nextOrder === undefined) {
        return prevOrder + 1;
      }
      return (prevOrder + nextOrder) / 2;
    },
    [cardsByColumn],
  );

  const handleCardDragStart = useCallback((columnId: string) => {
    setDraggingColumnId(columnId);
  }, []);

  const handleCardDragUpdate = useCallback(
    (absoluteX: number) => {
      const target = resolveDropColumnId(absoluteX);
      // Only re-render when the hovered column actually changes.
      setDropTargetColumnId((current) => (current === target ? current : target));
    },
    [resolveDropColumnId],
  );

  const handleCardDragEnd = useCallback(() => {
    setDraggingColumnId(null);
    setDropTargetColumnId(null);
  }, []);

  const moveCardToColumn = useCallback(
    (cardId: string, target: KanbanColumnData, order?: number) => {
      void mutations.moveCard({
        id: cardId,
        status: target.legacyStatus,
        ...(columnsSupported ? { columnId: target.id } : {}),
        ...(order !== undefined ? { order } : {}),
      });
    },
    [columnsSupported, mutations],
  );

  const handleCardDrop = useCallback<KanbanCardDropHandler>(
    ({ cardId, fromColumnId, absoluteX, absoluteY }) => {
      const targetId = resolveDropColumnId(absoluteX);
      if (!targetId) {
        return;
      }
      const target = columns.find((column) => column.id === targetId);
      if (!target) {
        return;
      }
      if (targetId === fromColumnId) {
        // Dropped back in its origin column: only worth a move when there are
        // other cards to reorder against.
        const others = (cardsByColumn.get(targetId) ?? []).filter((card) => card.id !== cardId);
        if (others.length === 0) {
          return;
        }
      }
      const order = computeDropOrder(targetId, cardId, absoluteY);
      moveCardToColumn(cardId, target, order);
    },
    [cardsByColumn, columns, computeDropOrder, moveCardToColumn, resolveDropColumnId],
  );

  const handleCardPress = useCallback((card: StoredKanbanCard) => {
    setDetailCard(card);
  }, []);

  const handleCardLongPress = useCallback((card: StoredKanbanCard) => {
    setPickerCard(card);
  }, []);

  const handleCardDispatch = useCallback((card: StoredKanbanCard) => {
    setDispatchCard(card);
  }, []);

  const handlePickColumn = useCallback(
    (column: KanbanColumnData) => {
      if (pickerCard && resolveCardColumn(pickerCard, columns)?.id !== column.id) {
        moveCardToColumn(pickerCard.id, column);
      }
    },
    [columns, moveCardToColumn, pickerCard],
  );

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
  const closePicker = useCallback(() => setPickerCard(null), []);
  const closeRename = useCallback(() => setRenameTarget(null), []);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const handleHide = useCallback(
    (column: KanbanColumnData) => {
      void columnMutations.updateColumn({ id: column.id, hidden: true });
    },
    [columnMutations],
  );

  const handleMoveLeft = useCallback(
    (column: KanbanColumnData) => {
      const index = columns.findIndex((candidate) => candidate.id === column.id);
      const neighbor = index > 0 ? columns[index - 1] : undefined;
      if (!neighbor) {
        return;
      }
      void columnMutations.reorderColumn({ id: column.id, order: neighbor.order });
      void columnMutations.reorderColumn({ id: neighbor.id, order: column.order });
    },
    [columnMutations, columns],
  );

  const handleMoveRight = useCallback(
    (column: KanbanColumnData) => {
      const index = columns.findIndex((candidate) => candidate.id === column.id);
      const neighbor = index >= 0 && index < columns.length - 1 ? columns[index + 1] : undefined;
      if (!neighbor) {
        return;
      }
      void columnMutations.reorderColumn({ id: column.id, order: neighbor.order });
      void columnMutations.reorderColumn({ id: neighbor.id, order: column.order });
    },
    [columnMutations, columns],
  );

  const handleRenameSave = useCallback(
    async (title: string) => {
      if (!renameTarget) {
        return;
      }
      await columnMutations.updateColumn({ id: renameTarget.id, title });
    },
    [columnMutations, renameTarget],
  );

  const handleDeleteConfirm = useCallback(
    async (moveCardsToColumnId: string) => {
      if (!deleteTarget) {
        return;
      }
      await columnMutations.deleteColumn({ id: deleteTarget.id, moveCardsToColumnId });
    },
    [columnMutations, deleteTarget],
  );

  const handleAddColumn = useCallback(
    async (title: string) => {
      const maxOrder = columns.reduce((max, column) => Math.max(max, column.order), 0);
      await columnMutations.createColumn({
        title,
        legacyStatus: "wip",
        order: maxOrder + 1,
      });
    },
    [columnMutations, columns],
  );

  const deleteDestinations = useMemo(
    () => (deleteTarget ? columns.filter((column) => column.id !== deleteTarget.id) : []),
    [columns, deleteTarget],
  );

  return (
    <>
      <ScrollView
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsHorizontalScrollIndicator={false}
        testID="kanban-board"
      >
        {columns.map((column, index) => (
          <KanbanColumn
            key={column.id}
            column={column}
            cards={cardsByColumn.get(column.id) ?? EMPTY_COLUMN_CARDS}
            isDragging={draggingColumnId === column.id}
            isDropTarget={dropTargetColumnId === column.id && draggingColumnId !== column.id}
            onRegisterRef={registerColumnRef}
            onRegisterCardRef={registerCardRef}
            onCardDragBegin={measureColumns}
            onCardDragStart={handleCardDragStart}
            onCardDragUpdate={handleCardDragUpdate}
            onCardDragEnd={handleCardDragEnd}
            onCardPress={handleCardPress}
            onCardLongPress={handleCardLongPress}
            onCardDispatch={handleCardDispatch}
            onCardDrop={handleCardDrop}
            dragEnabled={dragEnabled}
            onRenameColumn={columnsSupported ? setRenameTarget : undefined}
            onHideColumn={columnsSupported ? handleHide : undefined}
            onMoveColumnLeft={columnsSupported ? handleMoveLeft : undefined}
            onMoveColumnRight={columnsSupported ? handleMoveRight : undefined}
            onDeleteColumn={columnsSupported ? setDeleteTarget : undefined}
            canMoveColumnLeft={index > 0}
            canMoveColumnRight={index < columns.length - 1}
            canDeleteColumn={columns.length > 1}
          />
        ))}
        {columnsSupported ? <KanbanAddColumn onCreate={handleAddColumn} /> : null}
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

      <KanbanStatusPickerSheet
        visible={pickerCard !== null}
        columns={columns}
        currentColumnId={
          pickerCard ? (resolveCardColumn(pickerCard, columns)?.id ?? undefined) : undefined
        }
        onSelect={handlePickColumn}
        onClose={closePicker}
      />

      {columnsSupported ? (
        <>
          <KanbanColumnRenameSheet
            key={renameTarget ? `rename:${renameTarget.id}` : "rename:none"}
            visible={renameTarget !== null}
            column={renameTarget}
            onClose={closeRename}
            onSave={handleRenameSave}
          />
          <KanbanColumnDeleteSheet
            key={deleteTarget ? `delete:${deleteTarget.id}` : "delete:none"}
            visible={deleteTarget !== null}
            column={deleteTarget}
            destinations={deleteDestinations}
            onClose={closeDelete}
            onConfirm={handleDeleteConfirm}
          />
        </>
      ) : null}
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
