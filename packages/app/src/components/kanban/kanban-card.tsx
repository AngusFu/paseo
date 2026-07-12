import { memo, useCallback, useMemo, useRef, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, ChevronUp, ChevronsUp } from "lucide-react-native";
import type { KanbanCardSource, StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { openExternalUrl } from "@/utils/open-external-url";

const THEME_ICON_SIZE = 16;
const LINK_ICON_SIZE = 12;
const PRIORITY_ICON_SIZE = 12;

// Max labels rendered as chips before collapsing the rest into a "+N" chip.
const MAX_VISIBLE_LABELS = 2;

// The ticket/MR number chip shown in the header. Jira = issue key
// ("SCIF-4990"), GitLab = the MR iid ("!1742"), manual cards have neither.
function cardIssueKey(source: KanbanCardSource): string | null {
  if (source.kind === "jira") {
    return source.issueKey;
  }
  if (source.kind === "gitlab") {
    return `!${source.mrIid}`;
  }
  return null;
}

export interface KanbanCardDropHandler {
  (params: { cardId: string; fromColumnId: string; absoluteX: number }): void;
}

interface KanbanCardProps {
  card: StoredKanbanCard;
  /** The column this card is currently rendered under (drag origin). */
  columnId: string;
  onPress: (card: StoredKanbanCard) => void;
  onLongPress: (card: StoredKanbanCard) => void;
  /** Touch-down: board re-measures column bounds before any movement. */
  onDragBegin: () => void;
  /** Drag activated: board raises this card's column above its siblings. */
  onDragStart: (columnId: string) => void;
  /** Each drag frame: board resolves and highlights the hovered column. */
  onDragUpdate: (absoluteX: number) => void;
  /** Drag settled/cancelled: board clears drag + drop-target state. */
  onDragEnd: () => void;
  /** Web pointer-drag drop reporter. Ignored when `dragEnabled` is false. */
  onDrop: KanbanCardDropHandler;
  /** True on web where pointer drag works; false on native (long-press picker). */
  dragEnabled: boolean;
}

/**
 * A single Kanban card. Front shows the theme glyph, the title, and — when the
 * card has a URL — an "open link" affordance. Tapping opens the detail sheet;
 * long-press opens the status picker (the native path to change columns). On
 * web the whole card is a pointer-drag handle for cross-column moves.
 */
export const KanbanCard = memo(function KanbanCard({
  card,
  columnId,
  onPress,
  onLongPress,
  onDragBegin,
  onDragStart,
  onDragUpdate,
  onDragEnd,
  onDrop,
  dragEnabled,
}: KanbanCardProps): ReactElement {
  const { t } = useTranslation();
  const themeVisual = resolveKanbanCardTheme(card.theme);
  const iconColor = themeVisual.color ?? styles.defaultGlyph.color;
  const issueKey = cardIssueKey(card.source);
  const labels = card.labels ?? [];
  const visibleLabels = labels.slice(0, MAX_VISIBLE_LABELS);
  const hiddenLabelCount = labels.length - visibleLabels.length;
  const hasMeta = Boolean(card.assignee) || labels.length > 0 || Boolean(card.priority);
  const priorityVisual = useMemo(() => {
    if (card.priority === "high") {
      return { icon: ChevronsUp, color: styles.priorityHigh.color };
    }
    if (card.priority === "med") {
      return { icon: ChevronUp, color: styles.priorityMed.color };
    }
    return null;
  }, [card.priority]);

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const dragging = useSharedValue(false);

  // True once a drag actually activated during the current touch. Set on the
  // Pan's onStart, cleared at every touch-down (onBegin). A release after a drag
  // still fires the Pressable's onPress, so we swallow it here — otherwise
  // dropping a card would also open its edit sheet.
  const draggedRef = useRef(false);
  const markDragged = useCallback(() => {
    draggedRef.current = true;
  }, []);
  const clearDragged = useCallback(() => {
    draggedRef.current = false;
  }, []);

  const handlePress = useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onPress(card);
  }, [onPress, card]);
  const handleLongPress = useCallback(() => onLongPress(card), [onLongPress, card]);
  const handleOpenUrl = useCallback(() => {
    if (card.url) {
      void openExternalUrl(card.url);
    }
  }, [card.url]);

  const panGesture = Gesture.Pan()
    .enabled(dragEnabled)
    // Drag is web-only (mouse/trackpad): activate on a small movement so
    // grab-and-drag works immediately, while a motionless click still opens
    // the sheet. No long-press hold — that made pointer drags feel dead.
    .minDistance(4)
    // Measure columns at touch-down, before any movement, so drop hit-testing
    // uses fresh window bounds (no scroll happens during the drag).
    .onBegin(() => {
      // Fresh touch: clear the drag flag so a genuine tap opens the sheet.
      runOnJS(clearDragged)();
      runOnJS(onDragBegin)();
    })
    .onStart(() => {
      dragging.value = true;
      runOnJS(markDragged)();
      runOnJS(onDragStart)(columnId);
    })
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;
      runOnJS(onDragUpdate)(event.absoluteX);
    })
    .onEnd((event) => {
      runOnJS(onDrop)({
        cardId: card.id,
        fromColumnId: columnId,
        absoluteX: event.absoluteX,
      });
      translateX.value = 0;
      translateY.value = 0;
      dragging.value = false;
    })
    .onFinalize(() => {
      translateX.value = 0;
      translateY.value = 0;
      dragging.value = false;
      runOnJS(onDragEnd)();
    });

  const animatedStyle = useAnimatedStyle(() => ({
    // position:relative so the zIndex is honoured on web (RN Web only stacks
    // positioned elements), letting the lifted card sit above sibling cards.
    position: "relative",
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
    zIndex: dragging.value ? 10 : 0,
    opacity: dragging.value ? 0.92 : 1,
  }));

  const cardStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.card, pressed && styles.cardPressed],
    [],
  );

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={animatedStyle}>
        <Pressable
          style={cardStyle}
          onPress={handlePress}
          onLongPress={handleLongPress}
          accessibilityRole="button"
          accessibilityLabel={card.title}
          testID={`kanban-card-${card.id}`}
        >
          <View style={styles.header}>
            <themeVisual.icon size={THEME_ICON_SIZE} color={iconColor} />
            {issueKey ? (
              <View style={styles.issueKeyChip}>
                <Text style={styles.issueKeyText}>{issueKey}</Text>
              </View>
            ) : null}
            <View style={styles.headerSpacer} />
            {card.url ? (
              <Pressable
                onPress={handleOpenUrl}
                accessibilityRole="link"
                accessibilityLabel={t("kanban.card.open")}
                testID={`kanban-card-url-${card.id}`}
                hitSlop={6}
              >
                <ArrowUpRight size={LINK_ICON_SIZE} color={styles.linkButton.color} />
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.title} numberOfLines={2}>
            {card.title}
          </Text>
          {hasMeta ? (
            <View style={styles.metaRow}>
              {card.assignee ? (
                <Text style={styles.assignee} numberOfLines={1}>
                  {card.assignee}
                </Text>
              ) : null}
              {visibleLabels.map((label) => (
                <View key={label} style={styles.labelChip}>
                  <Text style={styles.labelText} numberOfLines={1}>
                    {label}
                  </Text>
                </View>
              ))}
              {hiddenLabelCount > 0 ? (
                <View style={styles.labelChip}>
                  <Text style={styles.labelText}>
                    {t("kanban.card.moreLabels", { count: hiddenLabelCount })}
                  </Text>
                </View>
              ) : null}
              {priorityVisual ? (
                <priorityVisual.icon size={PRIORITY_ICON_SIZE} color={priorityVisual.color} />
              ) : null}
            </View>
          ) : null}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create((theme) => ({
  // Static color holder for the default (unthemed) card glyph.
  defaultGlyph: {
    color: theme.colors.foregroundMuted,
  },
  card: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  cardPressed: {
    backgroundColor: theme.colors.surface3,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  headerSpacer: {
    flex: 1,
  },
  // Matches the StatusBadge pill shell (rounded, bordered) so the ticket key
  // and the status tag read as one family — only the mono font differs. Kept in
  // sync with the identical copy in kanban-card-detail-sheet.tsx.
  issueKeyChip: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  issueKeyText: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  // Static color holder for the external-link icon button.
  linkButton: {
    color: theme.colors.foregroundMuted,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  assignee: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  labelChip: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[1.5],
  },
  labelText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // Static color holders for priority icons — high is urgent (red), med is
  // elevated (amber). Low priority renders no icon.
  priorityHigh: {
    color: theme.colors.statusDanger,
  },
  priorityMed: {
    color: theme.colors.statusWarning,
  },
}));
