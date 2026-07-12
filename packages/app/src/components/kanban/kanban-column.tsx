import { memo, useCallback, useMemo, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { StoredKanbanCard, KanbanStatus } from "@getpaseo/protocol/kanban/types";
import { KanbanCard, type KanbanCardDropHandler } from "@/components/kanban/kanban-card";

export interface KanbanColumnBounds {
  x: number;
  width: number;
}

interface KanbanColumnProps {
  status: KanbanStatus;
  label: string;
  cards: StoredKanbanCard[];
  /** True while a card from THIS column is being dragged (raises it above siblings). */
  isDragging: boolean;
  /** True while a drag hovers over this column (Jira-style drop highlight). */
  isDropTarget: boolean;
  /** Registers this column's View with the board so it can be measured on drag. */
  onRegisterRef: (status: KanbanStatus, node: View | null) => void;
  /** Touch-down on a card: board re-measures column bounds. */
  onCardDragBegin: () => void;
  /** Drag activated: board raises the card's column. */
  onCardDragStart: (status: KanbanStatus) => void;
  /** Drag frame: board highlights the hovered column. */
  onCardDragUpdate: (absoluteX: number) => void;
  /** Drag settled/cancelled: board clears drag state. */
  onCardDragEnd: () => void;
  onCardPress: (card: StoredKanbanCard) => void;
  onCardLongPress: (card: StoredKanbanCard) => void;
  onCardDrop: KanbanCardDropHandler;
  dragEnabled: boolean;
}

/**
 * One board column: a full-height lane with a pinned status header + live count
 * and a vertically-scrolling card list (so tall columns don't overflow the
 * board). Registers its View with the board (for drag hit-testing), raises above
 * siblings while its own card drags, and shows a drop highlight when hovered.
 *
 * Scroll vs drag: on native the card Pan is disabled (drag is web-only), so the
 * ScrollView scrolls freely. On web, wheel/trackpad scrolls the list while the
 * card's long-press-activated Pan (activateAfterLongPress) only starts on hold,
 * so the two don't fight. The drop hit-test is on the outer column View's X
 * bounds, which the inner scroll doesn't change.
 */
export const KanbanColumn = memo(function KanbanColumn({
  status,
  label,
  cards,
  isDragging,
  isDropTarget,
  onRegisterRef,
  onCardDragBegin,
  onCardDragStart,
  onCardDragUpdate,
  onCardDragEnd,
  onCardPress,
  onCardLongPress,
  onCardDrop,
  dragEnabled,
}: KanbanColumnProps): ReactElement {
  const handleRef = useCallback(
    (node: View | null) => {
      onRegisterRef(status, node);
    },
    [onRegisterRef, status],
  );

  const columnStyle = useMemo(
    () => [
      styles.column,
      isDropTarget && styles.columnDropTarget,
      // Raise the dragging column (and its overflowing card) above neighbours,
      // which have opaque backgrounds and are painted after it.
      isDragging && styles.columnDragging,
    ],
    [isDragging, isDropTarget],
  );

  // While a card in this column is being dragged (web only), stop the list
  // ScrollView from clipping it — otherwise the lifted card gets cut at the
  // column edge and hidden under the neighbouring column. No scroll happens
  // during a drag, so dropping the clip is safe; it restores on drag end.
  const cardScrollStyle = useMemo(
    () => [styles.cardScroll, isDragging && styles.scrollDragging],
    [isDragging],
  );

  return (
    <View ref={handleRef} style={columnStyle} testID={`kanban-column-${status}`}>
      <View style={styles.header}>
        <Text style={styles.headerLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.headerCount} testID={`kanban-column-count-${status}`}>
          {cards.length}
        </Text>
      </View>
      <ScrollView
        style={cardScrollStyle}
        contentContainerStyle={styles.cardList}
        showsVerticalScrollIndicator
      >
        {cards.map((card) => (
          <KanbanCard
            key={card.id}
            card={card}
            onPress={onCardPress}
            onLongPress={onCardLongPress}
            onDragBegin={onCardDragBegin}
            onDragStart={onCardDragStart}
            onDragUpdate={onCardDragUpdate}
            onDragEnd={onCardDragEnd}
            onDrop={onCardDrop}
            dragEnabled={dragEnabled}
          />
        ))}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  column: {
    width: 260,
    flexShrink: 0,
    // Relative so the raised `columnDragging` zIndex actually stacks on web
    // (React Native Web honours zIndex only on positioned elements).
    position: "relative",
    // Full-height lane (Jira-style): stretch to the board height so the whole
    // column, including the empty space below the cards, is a drop zone.
    alignSelf: "stretch",
    minHeight: 200,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  columnDragging: {
    // Sibling columns have opaque backgrounds and paint after this one, so a
    // card dragged past this column's edge would slip under them without this.
    zIndex: 50,
    elevation: 8,
  },
  columnDropTarget: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingTop: theme.spacing[1],
  },
  headerLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  headerCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // Bounded, scrollable region below the pinned header. minHeight:0 lets it
  // shrink inside the column's flex layout on web so it actually scrolls.
  cardScroll: {
    flex: 1,
    minHeight: 0,
  },
  // Applied only during a drag: let the lifted card escape the column bounds so
  // the column's raised zIndex can paint it above the neighbouring column.
  scrollDragging: {
    overflow: "visible",
  },
  cardList: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
}));
