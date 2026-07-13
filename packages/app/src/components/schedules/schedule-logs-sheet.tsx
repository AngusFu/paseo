import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, RotateCw } from "lucide-react-native";
import type { ScheduleRun } from "@getpaseo/protocol/schedule/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { StatusBadge } from "@/components/ui/status-badge";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Button } from "@/components/ui/button";
import { useScheduleLogs } from "@/hooks/use-schedule-logs";
import { formatTimeAgo } from "@/utils/time";
import type { Theme } from "@/styles/theme";

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Wider than the default form sheet — log lines need horizontal room — and only
// the newest runs are shown so history stays cheap to render.
const LOGS_SHEET_MAX_WIDTH = 760;
const MAX_VISIBLE_RUNS = 50;

export interface ScheduleLogsSheetProps {
  visible: boolean;
  onClose: () => void;
  serverId: string | null;
  scheduleId: string | null;
  scheduleTitle: string;
}

// Elapsed wall-clock of a run, formatted compact (ELK/console style). Running
// runs (no endedAt) read as in-progress rather than a bogus duration.
function formatRunDuration(run: ScheduleRun, t: ReturnType<typeof useTranslation>["t"]): string {
  if (!run.endedAt) {
    return t("schedule.logs.running");
  }
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function runStatusBadge(status: ScheduleRun["status"]): {
  labelKey: string;
  variant: "success" | "error" | "muted";
} {
  switch (status) {
    case "succeeded":
      return { labelKey: "schedule.logs.status.succeeded", variant: "success" };
    case "failed":
      return { labelKey: "schedule.logs.status.failed", variant: "error" };
    case "running":
      return { labelKey: "schedule.logs.status.running", variant: "muted" };
  }
}

function RunEntry({
  run,
  isFirst,
  expanded,
  onToggle,
}: {
  run: ScheduleRun;
  isFirst: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const badge = runStatusBadge(run.status);
  const duration = formatRunDuration(run, t);
  const startedAgo = formatTimeAgo(new Date(run.startedAt));
  const hasOutput = Boolean(run.output && run.output.length > 0);
  const hasError = Boolean(run.error && run.error.length > 0);

  const handlePress = useCallback(() => onToggle(run.id), [onToggle, run.id]);

  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.entryHeader,
      !isFirst && styles.entryHeaderBorder,
      (Boolean(hovered) || pressed) && styles.entryHeaderActive,
    ],
    [isFirst],
  );

  return (
    <View style={styles.entry}>
      <Pressable
        style={headerStyle}
        onPress={handlePress}
        accessibilityRole="button"
        testID={`schedule-log-run-${run.id}`}
      >
        <View style={styles.entryChevron}>
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
          ) : (
            <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
          )}
        </View>
        <StatusBadge label={t(badge.labelKey)} variant={badge.variant} />
        <Text style={styles.entryTime} numberOfLines={1}>
          {startedAgo}
        </Text>
        <View style={styles.entrySpacer} />
        <Text style={styles.entryMeta} numberOfLines={1}>
          {duration}
        </Text>
        {run.exitCode !== null && run.exitCode !== undefined ? (
          <Text style={styles.entryMeta} numberOfLines={1}>
            {t("schedule.logs.exitCode", { code: run.exitCode })}
          </Text>
        ) : null}
      </Pressable>

      {expanded ? (
        <View style={styles.output}>
          {hasError ? (
            <Text style={styles.outputError} selectable>
              {run.error}
            </Text>
          ) : null}
          {hasOutput ? (
            <Text style={styles.outputText} selectable>
              {run.output}
            </Text>
          ) : null}
          {!hasOutput && !hasError ? (
            <Text style={styles.outputEmpty}>{t("schedule.logs.noOutput")}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A schedule's run history as a log viewer (ELK/console style): newest run
 * first, each collapsible into its captured stdout/stderr tail. Opened from a
 * row's kebab; refetches on every open since the list screen never carries run
 * data.
 */
export function ScheduleLogsSheet({
  visible,
  onClose,
  serverId,
  scheduleId,
  scheduleTitle,
}: ScheduleLogsSheetProps): ReactElement {
  const { t } = useTranslation();
  const { runs, isLoading, isRefetching, isError, refetch } = useScheduleLogs({
    serverId,
    scheduleId,
    enabled: visible,
  });

  // Newest first — the daemon returns runs oldest-to-newest by startedAt — and
  // capped at the 50 most recent so a long-lived schedule's history stays light.
  const orderedRuns = useMemo(() => runs.toReversed().slice(0, MAX_VISIBLE_RUNS), [runs]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const toggleRun = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const header = useMemo<SheetHeader>(
    () => ({
      title: scheduleTitle,
      subtitle: <Text style={styles.subtitle}>{t("schedule.logs.title")}</Text>,
      actions: (
        <Pressable
          onPress={refetch}
          hitSlop={8}
          style={refreshButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("schedule.logs.refresh")}
          testID="schedule-logs-refresh"
        >
          <ThemedRotateCw size={16} uniProps={mutedColorMapping} />
        </Pressable>
      ),
    }),
    [scheduleTitle, refetch, t],
  );

  // The newest run is the one users almost always want, so open it by default
  // whenever the fetched set changes and nothing is expanded yet.
  const newestRunId = orderedRuns[0]?.id ?? null;
  const shouldAutoExpand = newestRunId !== null && expandedIds.size === 0;

  let body: ReactElement;
  if (isLoading) {
    body = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (isError) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("schedule.logs.loadError")}</Text>
        <Button variant="ghost" size="sm" onPress={refetch} testID="schedule-logs-retry">
          {t("schedule.list.tryAgain")}
        </Button>
      </View>
    );
  } else if (orderedRuns.length === 0) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("schedule.logs.empty")}</Text>
      </View>
    );
  } else {
    body = (
      <View style={styles.list} testID="schedule-logs-list">
        {orderedRuns.map((run, index) => (
          <RunEntry
            key={run.id}
            run={run}
            isFirst={index === 0}
            expanded={expandedIds.has(run.id) || (shouldAutoExpand && run.id === newestRunId)}
            onToggle={toggleRun}
          />
        ))}
        {isRefetching ? (
          <View style={styles.refetchRow}>
            <LoadingSpinner size="small" color={styles.spinner.color} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={LOGS_SHEET_MAX_WIDTH}
      webScrollbar
      testID="schedule-logs-sheet"
    >
      <View style={styles.bodyMinHeight}>{body}</View>
    </AdaptiveModalSheet>
  );
}

function refreshButtonStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.refreshButton, hovered && styles.refreshButtonHovered];
}

const styles = StyleSheet.create((theme) => ({
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // Keep the modal from collapsing to a thin strip when a schedule has few (or
  // one) runs — a log viewer reads better with vertical room to breathe.
  bodyMinHeight: {
    minHeight: 320,
  },
  centered: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  list: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  entry: {
    backgroundColor: theme.colors.surface0,
  },
  entryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  entryHeaderBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  entryHeaderActive: {
    backgroundColor: theme.colors.surface2,
  },
  entryChevron: {
    width: 14,
    alignItems: "center",
  },
  entryTime: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  entrySpacer: {
    flex: 1,
    minWidth: theme.spacing[2],
  },
  entryMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  output: {
    backgroundColor: theme.colors.surface1,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[2],
  },
  outputText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    lineHeight: theme.fontSize.xs * 1.5,
  },
  outputError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    lineHeight: theme.fontSize.xs * 1.5,
  },
  outputEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
  },
  refetchRow: {
    paddingVertical: theme.spacing[2],
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  refreshButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  refreshButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
