import { memo, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import type {
  StoredKanbanCard,
  KanbanColumn as KanbanColumnData,
} from "@getpaseo/protocol/kanban/types";
import { KanbanCard, type KanbanCardDropHandler } from "@/components/kanban/kanban-card";
import { KanbanColumnMenu } from "@/components/kanban/kanban-column-menu";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";

export interface KanbanColumnBounds {
  x: number;
  width: number;
}

interface KanbanColumnProps {
  column: KanbanColumnData;
  cards: StoredKanbanCard[];
  /** True while a card from THIS column is being dragged (raises it above siblings). */
  isDragging: boolean;
  /** True while a drag hovers over this column (Jira-style drop highlight). */
  isDropTarget: boolean;
  /** True while a write-back drag is active and this column is NOT a legal
   * transition target for the card being dragged (dims it so the legal
   * lane(s) read as the only valid drop zones). Never combined with
   * isDropTarget — a dimmed column can't also be the hovered target. */
  dimmed?: boolean;
  /** Registers this column's View with the board so it can be measured on drag. */
  onRegisterRef: (columnId: string, node: View | null) => void;
  /** Registers one card's wrapper View with the board so its Y bounds can be
   * measured on drag (for in-column insert-position hit-testing). */
  onRegisterCardRef: (cardId: string, node: View | null) => void;
  /** Touch-down on a card: board re-measures column bounds. */
  onCardDragBegin: () => void;
  /** Drag activated: board raises the card's column. */
  onCardDragStart: (columnId: string, cardId: string) => void;
  /** Drag frame: board highlights the hovered column. */
  onCardDragUpdate: (absoluteX: number) => void;
  /** Drag settled/cancelled: board clears drag state. */
  onCardDragEnd: () => void;
  onCardPress: (card: StoredKanbanCard) => void;
  onCardLongPress: (card: StoredKanbanCard) => void;
  onCardDispatch: (card: StoredKanbanCard) => void;
  onCardDrop: KanbanCardDropHandler;
  dragEnabled: boolean;
  /** Column management (kebab menu) is only shown when the host supports the
   * columns capability. `onRenameColumn` is used as the presence sentinel —
   * flattened props (rather than one settings object) avoid recreating an
   * object literal on every render. */
  onRenameColumn?: (column: KanbanColumnData) => void;
  onHideColumn?: (column: KanbanColumnData) => void;
  onMoveColumnLeft?: (column: KanbanColumnData) => void;
  onMoveColumnRight?: (column: KanbanColumnData) => void;
  onDeleteColumn?: (column: KanbanColumnData) => void;
  canMoveColumnLeft?: boolean;
  canMoveColumnRight?: boolean;
  canDeleteColumn?: boolean;
}

/**
 * One board column: a full-height lane with a pinned status header + live count
 * and a vertically-scrolling card list (so tall columns don't overflow the
 * board). Registers its View with the board (for drag hit-testing), raises above
 * siblings while its own card drags, and shows a drop highlight when hovered.
 *
 * Scroll vs drag: on native the card Pan is disabled (drag is web-only), so the
 * ScrollView scrolls freely. On web, wheel/trackpad scrolls the list while the
 * card's pointer-drag Pan (minDistance(4)) only activates once the pointer has
 * actually moved, so the two don't fight. The drop hit-test is on the outer
 * column View's X bounds, which the inner scroll doesn't change.
 */
// Reused across renders so each card's ref callback keeps a stable identity
// (an inline arrow in the map below would re-fire the ref on every render).
function useCardRefCallback(
  onRegisterCardRef: (cardId: string, node: View | null) => void,
): (cardId: string) => (node: View | null) => void {
  const callbacksRef = useRef(new Map<string, (node: View | null) => void>());
  return useCallback(
    (cardId: string) => {
      let callback = callbacksRef.current.get(cardId);
      if (!callback) {
        callback = (node) => onRegisterCardRef(cardId, node);
        callbacksRef.current.set(cardId, callback);
      }
      return callback;
    },
    [onRegisterCardRef],
  );
}

interface CollapsedColumnStripProps {
  column: KanbanColumnData;
  cardCount: number;
  columnStyle: StyleProp<ViewStyle>;
  isHovered: boolean;
  showCollapseToggle: boolean;
  onToggle: () => void;
  onRegisterRef: (node: View | null) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/**
 * Collapsed lane: a narrow "drawer edge" the full height of the row. The
 * whole strip is the tap target (click anywhere to expand) — the chevron is
 * just a hover/native affordance, not the only way in. Split out from
 * KanbanColumn so its own style-array memoization doesn't push the parent
 * over the lint complexity budget.
 */
const CollapsedColumnStrip = memo(function CollapsedColumnStrip({
  column,
  cardCount,
  columnStyle,
  isHovered,
  showCollapseToggle,
  onToggle,
  onRegisterRef,
  onPointerEnter,
  onPointerLeave,
}: CollapsedColumnStripProps): ReactElement {
  const { t } = useTranslation();
  const bodyStyle = useMemo(
    () => [styles.collapsedBody, isHovered && styles.collapsedBodyHovered],
    [isHovered],
  );
  const chevronStyle = useMemo(
    () => [styles.collapsedChevron, !showCollapseToggle && styles.hiddenAffordance],
    [showCollapseToggle],
  );

  return (
    <View
      ref={onRegisterRef}
      style={columnStyle}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      testID={`kanban-column-${column.id}`}
    >
      <Pressable
        onPress={onToggle}
        style={bodyStyle}
        accessibilityRole="button"
        accessibilityLabel={t("kanban.column.expand")}
        testID={`kanban-column-collapse-${column.id}`}
      >
        <ChevronRight size={14} color={styles.collapseIcon.color} style={chevronStyle} />
        <View style={styles.collapsedTitleOuter}>
          {/* No numberOfLines here: React Native Web's numberOfLines
              implementation adds `maxWidth: 100%`, which clamps this Text
              down to collapsedTitleOuter's clipped 24px width regardless of
              the explicit 200px style width (maxWidth wins over width) —
              that's what was truncating "Backlog" to "B…" even after
              flexShrink:0. Truncation isn't needed here anyway:
              collapsedTitleOuter's overflow:hidden already clips whatever
              doesn't fit post-rotation. */}
          <Text style={styles.collapsedTitleInner}>{column.title}</Text>
        </View>
        <Text style={styles.collapsedCount} testID={`kanban-column-count-${column.id}`}>
          {cardCount}
        </Text>
      </Pressable>
    </View>
  );
});

export const KanbanColumn = memo(function KanbanColumn({
  column,
  cards,
  isDragging,
  isDropTarget,
  dimmed = false,
  onRegisterRef,
  onRegisterCardRef,
  onCardDragBegin,
  onCardDragStart,
  onCardDragUpdate,
  onCardDragEnd,
  onCardPress,
  onCardLongPress,
  onCardDispatch,
  onCardDrop,
  dragEnabled,
  onRenameColumn,
  onHideColumn,
  onMoveColumnLeft,
  onMoveColumnRight,
  onDeleteColumn,
  canMoveColumnLeft = false,
  canMoveColumnRight = false,
  canDeleteColumn = false,
}: KanbanColumnProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const getCardRefCallback = useCardRefCallback(onRegisterCardRef);
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const showHeaderMenu = Boolean(onRenameColumn) && (isHovered || isNative || isCompact);
  // Collapse toggle affordance (the chevron) only needs to be visible on
  // hover/native/compact — same reveal rule as the kebab menu. It's always
  // mounted (opacity + pointerEvents, not conditional render) so nothing
  // shifts the header layout when hover state flips (docs/hover.md #2).
  const showCollapseToggle = isHovered || isNative || isCompact;
  // Local, unpersisted — collapsing is a per-view space-saver (Jira-style),
  // not board state, so it resets on remount like a native disclosure widget.
  // Defaults to collapsed for a column that starts empty (the original pain
  // point this feature exists for: a row of 0-card status columns pushing
  // columns with real cards off-screen) and expanded otherwise. Lazy
  // initializer only — this is a DEFAULT, not a live sync with card count,
  // so once the user toggles a column it stays put for the rest of the
  // session even if its card count later changes (e.g. a card lands in it).
  const [collapsed, setCollapsed] = useState(() => cards.length === 0);
  const toggleCollapsed = useCallback(() => setCollapsed((current) => !current), []);

  const handleRef = useCallback(
    (node: View | null) => {
      onRegisterRef(column.id, node);
    },
    [onRegisterRef, column.id],
  );

  const columnStyle = useMemo(
    () => [
      styles.column,
      isDropTarget && styles.columnDropTarget,
      // Raise the dragging column (and its overflowing card) above neighbours,
      // which have opaque backgrounds and are painted after it.
      isDragging && styles.columnDragging,
      dimmed && styles.columnDimmed,
      collapsed && styles.columnCollapsed,
    ],
    [isDragging, isDropTarget, dimmed, collapsed],
  );

  // While a card in this column is being dragged (web only), stop the list
  // ScrollView from clipping it — otherwise the lifted card gets cut at the
  // column edge and hidden under the neighbouring column. No scroll happens
  // during a drag, so dropping the clip is safe; it restores on drag end.
  const cardScrollStyle = useMemo(
    () => [styles.cardScroll, isDragging && styles.scrollDragging],
    [isDragging],
  );

  const collapseButtonStyle = useMemo(
    () => [styles.collapseButton, !showCollapseToggle && styles.hiddenAffordance],
    [showCollapseToggle],
  );

  if (collapsed) {
    return (
      <CollapsedColumnStrip
        column={column}
        cardCount={cards.length}
        columnStyle={columnStyle}
        isHovered={isHovered}
        showCollapseToggle={showCollapseToggle}
        onToggle={toggleCollapsed}
        onRegisterRef={handleRef}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      />
    );
  }

  return (
    <View
      ref={handleRef}
      style={columnStyle}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`kanban-column-${column.id}`}
    >
      <View style={styles.header}>
        <Pressable
          onPress={toggleCollapsed}
          hitSlop={6}
          style={collapseButtonStyle}
          pointerEvents={showCollapseToggle ? "auto" : "none"}
          accessibilityRole="button"
          accessibilityLabel={t("kanban.column.collapse")}
          testID={`kanban-column-collapse-${column.id}`}
        >
          <ChevronLeft size={14} color={styles.collapseIcon.color} />
        </Pressable>
        <Text style={styles.headerLabel} numberOfLines={1}>
          {column.title}
        </Text>
        <Text style={styles.headerCount} testID={`kanban-column-count-${column.id}`}>
          {cards.length}
        </Text>
        {showHeaderMenu &&
        onRenameColumn &&
        onHideColumn &&
        onMoveColumnLeft &&
        onMoveColumnRight &&
        onDeleteColumn ? (
          <View style={styles.headerMenuSlot}>
            <KanbanColumnMenu
              column={column}
              canMoveLeft={canMoveColumnLeft}
              canMoveRight={canMoveColumnRight}
              canDelete={canDeleteColumn}
              onRename={onRenameColumn}
              onHide={onHideColumn}
              onMoveLeft={onMoveColumnLeft}
              onMoveRight={onMoveColumnRight}
              onDelete={onDeleteColumn}
            />
          </View>
        ) : null}
      </View>
      <ScrollView
        style={cardScrollStyle}
        contentContainerStyle={styles.cardList}
        showsVerticalScrollIndicator
      >
        {cards.map((card) => (
          <View key={card.id} ref={getCardRefCallback(card.id)}>
            <KanbanCard
              card={card}
              columnId={column.id}
              onPress={onCardPress}
              onLongPress={onCardLongPress}
              onDispatch={onCardDispatch}
              onDragBegin={onCardDragBegin}
              onDragStart={onCardDragStart}
              onDragUpdate={onCardDragUpdate}
              onDragEnd={onCardDragEnd}
              onDrop={onCardDrop}
              dragEnabled={dragEnabled}
            />
          </View>
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
  columnDimmed: {
    opacity: theme.opacity[50],
  },
  // Narrow drawer-edge strip: full column height, no header/card-list, just
  // a vertical title + count. Negative right margin pulls adjacent collapsed
  // strips closer together than expanded columns sit (a "group of drawer
  // edges" instead of isolated pillars) — harmless against an expanded
  // neighbour too, just a slightly tighter gap.
  columnCollapsed: {
    width: 40,
    minHeight: 0,
    padding: 0,
    marginRight: -(theme.spacing[3] / 2),
  },
  collapseIcon: {
    color: theme.colors.foregroundMuted,
  },
  // Hidden via opacity + pointerEvents (not conditional render) so revealing
  // it on hover never shifts surrounding layout — docs/hover.md failure mode 2.
  hiddenAffordance: {
    opacity: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingTop: theme.spacing[1],
    // Fixed slot height so the kebab reveal on hover doesn't shift the header.
    minHeight: 28,
  },
  collapseButton: {
    alignItems: "center",
    justifyContent: "center",
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
  headerMenuSlot: {
    flexDirection: "row",
    alignItems: "center",
  },
  // Whole-strip tap target: fills the column, centers the vertical title
  // block, chevron pinned near the top as a hover/native-only affordance.
  collapsedBody: {
    flex: 1,
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    // Lower-emphasis surface than an expanded column's header, and a subtle
    // hover highlight — same tone shift as columnDropTarget but quieter.
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
  },
  collapsedBodyHovered: {
    backgroundColor: theme.colors.surface2,
  },
  collapsedChevron: {
    marginTop: theme.spacing[1],
  },
  // Rotated-text hack: the inner Text lays out at a fixed width (long enough
  // for a full title) then rotates -90deg around its own center; the outer
  // wrapper clips the pre-rotation box to a narrow column so nothing paints
  // outside the strip (React Native + web both honour overflow:hidden here).
  collapsedTitleOuter: {
    flex: 1,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  collapsedTitleInner: {
    // flexShrink:0 is load-bearing: without it, React Native Web's flex
    // layout shrinks this Text to fit collapsedTitleOuter's clipped 24px
    // width BEFORE the rotate transform is applied (transforms are purely
    // visual, not layout), truncating "Backlog" down to "B…". Pinning the
    // pre-rotation box to its authored 160px width lets the full title lay
    // out, then the transform rotates that already-complete box into the
    // narrow strip; collapsedTitleOuter's overflow:hidden clips the
    // now-vertical excess. 200px gives multi-word titles ("Pending Design")
    // room to lay out on one line without wrapping.
    flexShrink: 0,
    width: 200,
    textAlign: "center",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    transform: [{ rotate: "-90deg" }],
  },
  collapsedCount: {
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
