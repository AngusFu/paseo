import { memo, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Image,
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, ChevronUp, ChevronsUp, Rocket } from "lucide-react-native";
import type { KanbanCardSource, StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { openExternalUrl } from "@/utils/open-external-url";

const THEME_ICON_SIZE = 16;
const LINK_ICON_SIZE = 12;
const PRIORITY_ICON_SIZE = 12;
const AVATAR_SIZE = 16;
const ISSUE_TYPE_ICON_SIZE = 16;

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

// Real Jira assignee avatar (board-density parity with Jira's own board —
// P3). Reads the raw Jira user object sync.ts already stores in
// card.metadata.assignee; pure + defensive since metadata is
// `Record<string, unknown> | undefined` on the wire. null for anything else
// (GitLab/manual cards, or a Jira card whose metadata predates this field),
// which just means the existing plain-text assignee name keeps rendering.
function jiraAssigneeAvatarUrl(card: StoredKanbanCard): string | null {
  if (card.source.kind !== "jira") {
    return null;
  }
  const assignee = card.metadata?.assignee;
  if (typeof assignee !== "object" || assignee === null || Array.isArray(assignee)) {
    return null;
  }
  const avatarUrls = (assignee as Record<string, unknown>).avatarUrls;
  if (typeof avatarUrls !== "object" || avatarUrls === null || Array.isArray(avatarUrls)) {
    return null;
  }
  const url = (avatarUrls as Record<string, unknown>)["24x24"];
  return typeof url === "string" && url.length > 0 ? url : null;
}

// Real Jira issue-type icon (Bug/Story/Task glyph — board-density parity
// with Jira's own board, P3). Reads sync.ts's metadata.issuetype{name,
// iconUrl}. null when the field is absent — older cards synced before this
// field was captured, or any non-Jira card — which means no icon renders
// (not a placeholder; see kanban-card.tsx render site).
function jiraIssueTypeIcon(card: StoredKanbanCard): { name: string; iconUrl: string } | null {
  if (card.source.kind !== "jira") {
    return null;
  }
  const issuetype = card.metadata?.issuetype;
  if (typeof issuetype !== "object" || issuetype === null || Array.isArray(issuetype)) {
    return null;
  }
  const { name, iconUrl } = issuetype as Record<string, unknown>;
  if (typeof iconUrl !== "string" || iconUrl.length === 0) {
    return null;
  }
  return { name: typeof name === "string" && name.length > 0 ? name : iconUrl, iconUrl };
}

export interface KanbanCardDropHandler {
  (params: { cardId: string; fromColumnId: string; absoluteX: number; absoluteY: number }): void;
}

interface KanbanCardProps {
  card: StoredKanbanCard;
  /** The column this card is currently rendered under (drag origin). */
  columnId: string;
  onPress: (card: StoredKanbanCard) => void;
  onLongPress: (card: StoredKanbanCard) => void;
  /** Hover quick-launch: open the dispatch panel straight from the card. */
  onDispatch: (card: StoredKanbanCard) => void;
  /** Touch-down: board re-measures column bounds before any movement. */
  onDragBegin: () => void;
  /** Drag activated: board raises this card's column above its siblings. */
  onDragStart: (columnId: string, cardId: string) => void;
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
  onDispatch,
  onDragBegin,
  onDragStart,
  onDragUpdate,
  onDragEnd,
  onDrop,
  dragEnabled,
}: KanbanCardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  // Hover-to-reveal on web; always visible where hover can't fire (native/compact).
  const showQuickActions = hovered || isNative || isCompact;
  // Hover tracked on a plain wrapper View via pointerenter/leave (non-bubbling),
  // NOT on the card Pressable — moving onto the nested action buttons must not
  // fire hover-out. See docs/hover.md (failure mode 1).
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handleDispatch = useCallback(
    (event: GestureResponderEvent) => {
      // Stop the press from bubbling to the card Pressable (which opens detail).
      event?.stopPropagation?.();
      onDispatch(card);
    },
    [onDispatch, card],
  );
  const themeVisual = resolveKanbanCardTheme(card.theme);
  const iconColor = themeVisual.color ?? styles.defaultGlyph.color;
  const issueKey = cardIssueKey(card.source);
  const labels = card.labels ?? [];
  const visibleLabels = labels.slice(0, MAX_VISIBLE_LABELS);
  const hiddenLabelCount = labels.length - visibleLabels.length;
  const hasMeta = Boolean(card.assignee) || labels.length > 0 || Boolean(card.priority);
  const avatarUrl = useMemo(() => jiraAssigneeAvatarUrl(card), [card]);
  const avatarSource = useMemo(() => (avatarUrl ? { uri: avatarUrl } : null), [avatarUrl]);
  const issueType = useMemo(() => jiraIssueTypeIcon(card), [card]);
  const issueTypeSource = useMemo(
    () => (issueType ? { uri: issueType.iconUrl } : null),
    [issueType],
  );
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
      runOnJS(onDragStart)(columnId, card.id);
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
        absoluteY: event.absoluteY,
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
        <View
          style={styles.cardContainer}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
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
              {issueTypeSource ? (
                <Image
                  source={issueTypeSource}
                  style={styles.issueTypeIcon}
                  accessibilityLabel={issueType?.name}
                />
              ) : null}
              {issueKey ? (
                <View style={styles.issueKeyChip}>
                  <Text style={styles.issueKeyText}>{issueKey}</Text>
                </View>
              ) : null}
              {card.hasUnresolvedThreads ? (
                <View
                  style={styles.unresolvedThreadsDot}
                  accessibilityLabel={t("kanban.card.unresolvedThreads")}
                />
              ) : null}
            </View>
            <Text style={styles.title} numberOfLines={2}>
              {card.title}
            </Text>
            {hasMeta ? (
              <View style={styles.metaRow}>
                {card.assignee ? (
                  <View style={styles.assigneeGroup}>
                    {avatarSource ? (
                      <Image
                        source={avatarSource}
                        style={styles.avatar}
                        accessibilityLabel={card.assignee}
                      />
                    ) : null}
                    <Text style={styles.assignee} numberOfLines={1}>
                      {card.assignee}
                    </Text>
                  </View>
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
          {/* Action buttons live OUTSIDE the card Pressable — nesting a
              <button>/<a> inside the card's <button> is invalid HTML and throws
              a web hydration error. Absolute overlay keeps them top-right. */}
          {showQuickActions || card.url ? (
            <View style={styles.cardActions} pointerEvents="box-none">
              {showQuickActions ? (
                <Pressable
                  onPress={handleDispatch}
                  accessibilityRole="button"
                  accessibilityLabel={t("kanban.cardDetail.dispatch")}
                  testID={`kanban-card-dispatch-${card.id}`}
                  hitSlop={6}
                >
                  <Rocket size={LINK_ICON_SIZE} color={styles.linkButton.color} />
                </Pressable>
              ) : null}
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
          ) : null}
        </View>
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
  cardContainer: {
    position: "relative",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  cardActions: {
    position: "absolute",
    top: theme.spacing[3],
    right: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  issueTypeIcon: {
    width: ISSUE_TYPE_ICON_SIZE,
    height: ISSUE_TYPE_ICON_SIZE,
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
  // Red attention dot: MR has unresolved blocking discussion threads.
  unresolvedThreadsDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
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
  assigneeGroup: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: theme.borderRadius.full,
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
