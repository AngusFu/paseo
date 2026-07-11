import { useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
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
  /** Registers this column's View with the board so it can be measured on drag. */
  onRegisterRef: (status: KanbanStatus, node: View | null) => void;
  /** Fired when a card in any column starts dragging, so the board re-measures. */
  onCardDragBegin: () => void;
  onCardPress: (card: StoredKanbanCard) => void;
  onCardLongPress: (card: StoredKanbanCard) => void;
  onCardDrop: KanbanCardDropHandler;
  dragEnabled: boolean;
}

/**
 * One board column: a localized status header with a live count and a vertical
 * stack of cards. The column registers its View with the board, which measures
 * it in window coords at drag-start to hit-test a web pointer-drop.
 */
export function KanbanColumn({
  status,
  label,
  cards,
  onRegisterRef,
  onCardDragBegin,
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

  return (
    <View ref={handleRef} style={styles.column} testID={`kanban-column-${status}`}>
      <View style={styles.header}>
        <Text style={styles.headerLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.headerCount} testID={`kanban-column-count-${status}`}>
          {cards.length}
        </Text>
      </View>
      <View style={styles.cardList}>
        {cards.map((card) => (
          <KanbanCard
            key={card.id}
            card={card}
            onPress={onCardPress}
            onLongPress={onCardLongPress}
            onDragBegin={onCardDragBegin}
            onDrop={onCardDrop}
            dragEnabled={dragEnabled}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: 260,
    flexShrink: 0,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
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
  cardList: {
    gap: theme.spacing[2],
  },
}));
