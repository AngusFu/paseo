import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { deriveTodoListPresentation } from "./presentation";
import { selectLatestTodoListForTrack } from "./select-latest";
import { TodoListRows } from "./todo-list-rows";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const EMPTY_STREAM_ITEMS: readonly StreamItem[] = [];
const TODOS_LIST_MAX_HEIGHT = 200;

export interface TodosTrackProps {
  serverId: string;
  agentId: string;
  /** True when another composer track (e.g. Subagents) is rendered above this one. */
  stackedBelowTrack?: boolean;
}

export function TodosTrack({
  serverId,
  agentId,
  stackedBelowTrack = false,
}: TodosTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const latest = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      selectLatestTodoListForTrack(
        state.sessions[serverId]?.agentStreamTail?.get(agentId) ?? EMPTY_STREAM_ITEMS,
      ),
    (a, b) => a?.id === b?.id && a?.items === b?.items,
  );

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const surfaceStyle = useMemo(
    () => [
      styles.surface,
      stackedBelowTrack && styles.surfaceStacked,
      expanded && styles.surfaceExpanded,
    ],
    [expanded, stackedBelowTrack],
  );

  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.headerToggle,
      (hovered || pressed) && styles.headerActive,
    ],
    [],
  );
  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );

  const presentation = useMemo(
    () => (latest ? deriveTodoListPresentation(latest.items) : null),
    [latest],
  );

  if (!latest || !presentation) {
    return null;
  }

  const title = t("message.todo.title");
  const headerLabel = presentation.secondaryLabel
    ? `${title} · ${presentation.secondaryLabel}`
    : title;

  return (
    <View style={styles.outer} testID="todos-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              testID="todos-track-header"
              onPress={toggleExpanded}
              style={headerStyle}
            >
              {expanded ? (
                <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
              )}
              <Text style={styles.headerLabel} numberOfLines={1}>
                {headerLabel}
              </Text>
            </Pressable>
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              <View style={styles.rows}>
                <TodoListRows items={latest.items} />
              </View>
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  // Under another composer track: drop the top cap so the dock reads as one stack.
  surfaceStacked: {
    borderTopWidth: 0,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[4],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    maxHeight: TODOS_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  rows: {
    paddingHorizontal: theme.spacing[3],
  },
}));
