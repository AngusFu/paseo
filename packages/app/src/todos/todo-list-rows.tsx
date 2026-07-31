import { memo, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";
import { deriveTodoListPresentation } from "./presentation";

const ThemedTodoCheckIcon = withUnistyles(Check);

const primaryForegroundColorMapping = (theme: Theme) => ({
  color: theme.colors.primaryForeground,
});

interface TodoListItemRowProps {
  text: string;
  status: TodoEntry["status"];
  isCurrent: boolean;
}

export function TodoListItemRow({ text, status, isCurrent }: TodoListItemRowProps): ReactElement {
  const completed = status === "completed";
  const inProgress = status === "in_progress";
  const badgeStyle = useMemo(
    () => [
      styles.radioBadge,
      completed && styles.radioBadgeComplete,
      inProgress && styles.radioBadgeInProgress,
      !completed && !inProgress && styles.radioBadgePending,
    ],
    [completed, inProgress],
  );
  const textStyle = useMemo(
    () => [
      styles.itemText,
      inProgress && styles.itemTextInProgress,
      completed && styles.itemTextCompleted,
    ],
    [completed, inProgress],
  );
  const rowStyle = useMemo(() => [styles.itemRow, isCurrent && styles.itemRowCurrent], [isCurrent]);
  return (
    <View style={rowStyle}>
      <View style={badgeStyle}>
        {completed ? (
          <ThemedTodoCheckIcon size={10} uniProps={primaryForegroundColorMapping} />
        ) : null}
      </View>
      <Text style={textStyle}>{text}</Text>
    </View>
  );
}

export interface TodoListRowsProps {
  items: readonly TodoEntry[];
}

export const TodoListRows = memo(function TodoListRows({ items }: TodoListRowsProps): ReactElement {
  const { t } = useTranslation();
  const { currentIndex } = deriveTodoListPresentation(items);

  if (items.length === 0) {
    return <Text style={styles.emptyText}>{t("message.todo.empty")}</Text>;
  }

  return (
    <View style={styles.list}>
      {items.map((item, index) => (
        <TodoListItemRow
          key={`${item.status}:${item.completed ? "1" : "0"}:${item.text}`}
          text={item.text}
          status={item.status}
          isCurrent={index === currentIndex}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  itemRowCurrent: {
    backgroundColor: theme.colors.surface2,
  },
  radioBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: theme.borderWidth[2],
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  radioBadgePending: {
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: "transparent",
    opacity: 0.55,
  },
  radioBadgeInProgress: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  radioBadgeComplete: {
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.9,
  },
  itemText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  itemTextInProgress: {
    fontWeight: theme.fontWeight.medium,
  },
  itemTextCompleted: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
