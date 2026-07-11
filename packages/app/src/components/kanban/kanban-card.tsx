import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, GripVertical } from "lucide-react-native";
import type { StoredKanbanCard, KanbanStatus } from "@getpaseo/protocol/kanban/types";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { openExternalUrl } from "@/utils/open-external-url";

const THEME_ICON_SIZE = 16;

export interface KanbanCardDropHandler {
  (params: { cardId: string; fromStatus: KanbanStatus; absoluteX: number }): void;
}

interface KanbanCardProps {
  card: StoredKanbanCard;
  onPress: (card: StoredKanbanCard) => void;
  onLongPress: (card: StoredKanbanCard) => void;
  /** Touch-down: board re-measures column bounds before any movement. */
  onDragBegin: () => void;
  /** Drag activated: board raises this card's column above its siblings. */
  onDragStart: (status: KanbanStatus) => void;
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
export function KanbanCard({
  card,
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

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const dragging = useSharedValue(false);

  const handlePress = useCallback(() => onPress(card), [onPress, card]);
  const handleLongPress = useCallback(() => onLongPress(card), [onLongPress, card]);
  const handleOpenUrl = useCallback(() => {
    if (card.url) {
      void openExternalUrl(card.url);
    }
  }, [card.url]);

  const panGesture = Gesture.Pan()
    .enabled(dragEnabled)
    // Hold briefly before dragging so quick taps still open the sheet and
    // vertical list scrolling is not hijacked.
    .activateAfterLongPress(150)
    // Measure columns at touch-down, before any movement, so drop hit-testing
    // uses fresh window bounds (no scroll happens during the drag).
    .onBegin(() => {
      runOnJS(onDragBegin)();
    })
    .onStart(() => {
      dragging.value = true;
      runOnJS(onDragStart)(card.status);
    })
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;
      runOnJS(onDragUpdate)(event.absoluteX);
    })
    .onEnd((event) => {
      runOnJS(onDrop)({
        cardId: card.id,
        fromStatus: card.status,
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
            {/* Visible drag affordance on web, where the whole card is a pointer
                drag handle. Native uses long-press → status picker instead. */}
            {dragEnabled ? (
              <GripVertical size={14} color={styles.dragHandle.color} testID="kanban-card-grip" />
            ) : null}
            <themeVisual.icon size={THEME_ICON_SIZE} color={iconColor} />
            <Text style={styles.title} numberOfLines={2}>
              {card.title}
            </Text>
          </View>
          {card.url ? (
            <Pressable
              style={styles.urlRow}
              onPress={handleOpenUrl}
              accessibilityRole="link"
              accessibilityLabel={t("kanban.card.open")}
              testID={`kanban-card-url-${card.id}`}
              hitSlop={6}
            >
              <Text style={styles.urlText} numberOfLines={1}>
                {card.url}
              </Text>
              <ArrowUpRight size={12} color={styles.urlText.color} />
            </Pressable>
          ) : null}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Static color holder for the default (unthemed) card glyph.
  defaultGlyph: {
    color: theme.colors.foregroundMuted,
  },
  // Muted drag-handle glyph (web-only affordance).
  dragHandle: {
    color: theme.colors.foregroundMuted,
  },
  card: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardPressed: {
    backgroundColor: theme.colors.surface3,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  urlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  urlText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
