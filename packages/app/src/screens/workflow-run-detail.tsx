/**
 * Workflow run detail body — shared between the /workflows run detail sheet
 * and the workspace workflow_run tab panel. Renders run status, task,
 * outcome, the run's agents (tap → the agent's full timeline), the live
 * event log, and the debug args/result panels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import type { WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { getProviderIcon } from "@/components/provider-icons";
import { useToast } from "@/contexts/toast-context";
import type { useWorkflowRunLogs } from "@/hooks/use-workflow-run-logs";
import { summarizeWorkflowRun } from "@/screens/workflow-run-summary";
import { WorkspaceTabIcon } from "@/screens/workspace/workspace-tab-presentation";
import { useAgentsForWorkflowRun, type SubagentRow } from "@/subagents/select";
import { buildSubagentRowPresentationData } from "@/subagents/track-presentation";
import { buildWorkflowPhaseTree, type PhaseAgentStatus } from "@/screens/workflow-run-phase-tree";
import { formatTimeAgo } from "@/utils/time";

/** How close to the bottom (px) counts as "at bottom" for log auto-scroll. */
const LOG_BOTTOM_THRESHOLD = 48;

export function WorkflowRunDetailBody({
  run,
  summary,
  live,
  logs,
  serverId,
  onOpenAgent,
  showDebug,
  onToggleDebug,
}: {
  run: WorkflowRun;
  summary: ReturnType<typeof summarizeWorkflowRun>;
  live: boolean;
  logs: ReturnType<typeof useWorkflowRunLogs>;
  serverId: string | null;
  onOpenAgent: (agentId: string) => void;
  showDebug: boolean;
  onToggleDebug: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const argsText = JSON.stringify(run.args ?? {}, null, 2);
  const resultText = JSON.stringify(summary.resultPayload ?? null, null, 2);

  return (
    <View style={styles.detailStack}>
      <Text style={summary.displayStatus === "failed" ? styles.runStatusFailed : styles.cardTitle}>
        {t(`workflows.status.${summary.displayStatus}`)}
      </Text>
      <Text style={styles.meta}>
        {t("workflows.runQueuedAt", { time: formatTimeAgo(new Date(run.queuedAt)) })}
      </Text>

      <View style={styles.detailSection}>
        <Text style={styles.detailSectionLabel}>{t("workflows.task")}</Text>
        {summary.task ? (
          <Text style={styles.detailBody}>{summary.task}</Text>
        ) : (
          <Text style={styles.meta}>{t("workflows.runNoTask")}</Text>
        )}
      </View>

      {summary.outcome ? (
        <WorkflowDetailPanel
          title={t("workflows.runOutcome")}
          copyText={summary.outcome}
          testID="workflow-run-outcome-panel"
        >
          <View style={styles.detailPanelPadded}>
            <Text style={styles.errorText}>{summary.outcome}</Text>
            {summary.staleTaskContract ? (
              <Text style={styles.detailHint}>{t("workflows.runStaleTaskContractHint")}</Text>
            ) : null}
          </View>
        </WorkflowDetailPanel>
      ) : null}

      {summary.agentCalls !== null ? (
        <Text style={styles.meta}>
          {t("workflows.runAgentCalls", { count: summary.agentCalls })}
        </Text>
      ) : null}

      <WorkflowRunPhaseTree entries={logs.entries} />

      <WorkflowRunAgentList
        serverId={serverId}
        runId={run.id}
        live={live}
        onOpenAgent={onOpenAgent}
      />

      <WorkflowRunEventLog
        entries={logs.entries}
        isLoading={logs.isLoading}
        isFetchingMore={logs.isFetchingMore}
        isError={logs.isError}
        hasMore={logs.hasMore}
        live={live}
        onLoadMore={logs.loadMore}
        emptyLabel={live ? t("workflows.runLogsEmpty") : t("workflows.runLogsEmptyFinished")}
        loadingLabel={t("workflows.runLogsLoading")}
        loadMoreLabel={t("workflows.runLogsLoadMore")}
        errorLabel={t("workflows.runLogsError")}
        title={t("workflows.runLogs")}
      />

      <Pressable
        onPress={onToggleDebug}
        style={styles.debugToggle}
        testID="workflow-run-debug-toggle"
      >
        <Text style={styles.debugToggleText}>
          {showDebug ? t("workflows.runHideDebug") : t("workflows.runShowDebug")}
        </Text>
      </Pressable>
      {showDebug ? (
        <>
          <WorkflowDetailPanel
            title={t("workflows.runArgs")}
            copyText={argsText}
            testID="workflow-run-args-panel"
          >
            <ScrollView
              style={styles.detailJsonViewport}
              contentContainerStyle={styles.logViewportContent}
              nestedScrollEnabled
            >
              <Text style={styles.detailMono}>{argsText}</Text>
            </ScrollView>
          </WorkflowDetailPanel>
          <WorkflowDetailPanel
            title={t("workflows.runResult")}
            copyText={resultText}
            testID="workflow-run-result-panel"
          >
            <ScrollView
              style={styles.detailJsonViewport}
              contentContainerStyle={styles.logViewportContent}
              nestedScrollEnabled
            >
              <Text style={styles.detailMono}>{resultText}</Text>
            </ScrollView>
          </WorkflowDetailPanel>
        </>
      ) : null}
    </View>
  );
}

function WorkflowRunAgentList({
  serverId,
  runId,
  live,
  onOpenAgent,
}: {
  serverId: string | null;
  runId: string;
  live: boolean;
  onOpenAgent: (agentId: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const rows = useAgentsForWorkflowRun({ serverId, runId });

  // A finished run whose agents were purged from the store has nothing to
  // show — hide the section instead of rendering a stale "no agents" note.
  if (rows.length === 0 && !live) {
    return null;
  }

  return (
    <View style={styles.detailSection} testID="workflow-run-agents">
      <Text style={styles.detailSectionLabel}>{t("workflows.runAgents")}</Text>
      {rows.length === 0 ? (
        <Text style={styles.meta}>{t("workflows.runAgentsEmpty")}</Text>
      ) : (
        <View style={styles.runList}>
          {rows.map((row) => (
            <WorkflowRunAgentRow key={row.id} row={row} onOpenAgent={onOpenAgent} />
          ))}
        </View>
      )}
    </View>
  );
}

function WorkflowRunAgentRow({
  row,
  onOpenAgent,
}: {
  row: SubagentRow;
  onOpenAgent: (agentId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const presentation = useMemo(
    () => ({
      ...buildSubagentRowPresentationData(row),
      icon: getProviderIcon(row.provider),
    }),
    [row],
  );
  const label =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;
  const handlePress = useCallback(() => {
    onOpenAgent(row.id);
  }, [onOpenAgent, row.id]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={handlePress}
      style={styles.runRow}
      testID={`workflow-run-agent-${row.id}`}
    >
      <WorkspaceTabIcon presentation={presentation} />
      <Text style={styles.runRowTitle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

type WorkflowLogEntryLike = ReturnType<typeof useWorkflowRunLogs>["entries"][number];

function phaseDotStyle(status: PhaseAgentStatus) {
  if (status === "done") return styles.phaseDotDone;
  if (status === "error") return styles.phaseDotError;
  if (status === "retrying") return styles.phaseDotRetrying;
  return styles.phaseDotRunning;
}

function WorkflowRunPhaseTree({
  entries,
}: {
  entries: WorkflowLogEntryLike[];
}): ReactElement | null {
  const { t } = useTranslation();
  const groups = useMemo(() => buildWorkflowPhaseTree(entries), [entries]);
  if (groups.length === 0) {
    return null;
  }

  return (
    <View style={styles.detailSection} testID="workflow-run-phase-tree">
      <Text style={styles.detailSectionLabel}>{t("workflows.runPhases")}</Text>
      <View style={styles.phaseTree}>
        {groups.map((group) => (
          <View key={group.title ?? " no-phase"} style={styles.phaseGroup}>
            <Text style={styles.phaseTitle}>{group.title ?? t("workflows.runPhaseUngrouped")}</Text>
            {group.agents.map((agent) => (
              <View key={agent.callId} style={styles.phaseAgentRow}>
                <View style={phaseDotStyle(agent.status)} />
                <Text style={styles.phaseAgentLabel} numberOfLines={1}>
                  {agent.label ?? `agent #${agent.callId}`}
                </Text>
                {agent.model ? <Text style={styles.phaseAgentMeta}>{agent.model}</Text> : null}
                {agent.cached ? (
                  <Text style={styles.phaseAgentMeta}>{t("workflows.runPhaseCached")}</Text>
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

function WorkflowDetailPanel({
  title,
  chromeMeta,
  copyText,
  testID,
  children,
}: {
  title: string;
  chromeMeta?: "live" | number | null;
  copyText: string;
  testID?: string;
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const canCopy = copyText.trim().length > 0;
  const handleCopy = useCallback(() => {
    if (!canCopy) return;
    void (async () => {
      await Clipboard.setStringAsync(copyText);
      toast.copied();
    })();
  }, [canCopy, copyText, toast]);
  let chromeMetaNode: ReactNode = null;
  if (chromeMeta === "live") {
    chromeMetaNode = (
      <View style={styles.logLivePill}>
        <View style={styles.logLiveDot} />
        <Text style={styles.logLiveText}>{t("workflows.runLogsLive")}</Text>
      </View>
    );
  } else if (typeof chromeMeta === "number") {
    chromeMetaNode = <Text style={styles.logChromeCount}>{String(chromeMeta)}</Text>;
  }

  return (
    <View style={styles.logPanel} testID={testID}>
      <View style={styles.logChrome}>
        <Text style={styles.logChromeTitle}>{title}</Text>
        <View style={styles.logChromeRight}>
          {chromeMetaNode}
          <Pressable
            onPress={handleCopy}
            disabled={!canCopy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.copy")}
            style={canCopy ? styles.copyButton : styles.copyButtonDisabled}
            testID={testID ? `${testID}-copy` : undefined}
          >
            <Copy size={14} color={styles.copyIcon.color} />
          </Pressable>
        </View>
      </View>
      <View style={styles.detailPanelBody}>{children}</View>
    </View>
  );
}

function WorkflowRunEventLog({
  title,
  entries,
  isLoading,
  isFetchingMore,
  isError,
  hasMore,
  live,
  onLoadMore,
  emptyLabel,
  loadingLabel,
  loadMoreLabel,
  errorLabel,
}: {
  title: string;
  entries: Array<{ seq: number; ts: string; level: string; event: string; message: string }>;
  isLoading: boolean;
  isFetchingMore: boolean;
  isError: boolean;
  hasMore: boolean;
  live: boolean;
  onLoadMore: () => void;
  emptyLabel: string;
  loadingLabel: string;
  loadMoreLabel: string;
  errorLabel: string;
}): ReactElement {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);
  const isAtBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  useEffect(() => {
    if (!live || entries.length === 0 || !isAtBottomRef.current) return;
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    });
  }, [entries.length, live]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const atBottom = distanceFromBottom <= LOG_BOTTOM_THRESHOLD;
    isAtBottomRef.current = atBottom;
    setShowJumpToBottom(!atBottom);
  }, []);

  const jumpToBottom = useCallback(() => {
    isAtBottomRef.current = true;
    setShowJumpToBottom(false);
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  let placeholder = emptyLabel;
  if (isError) {
    placeholder = errorLabel;
  } else if (isLoading) {
    placeholder = loadingLabel;
  }

  const copyText =
    entries.length > 0
      ? entries
          .map(
            (entry) =>
              `${formatLogTime(entry.ts)} ${formatLogLevel(entry.level)} ${entry.event}  ${entry.message}`,
          )
          .join("\n")
      : `# ${placeholder}`;

  return (
    <WorkflowDetailPanel
      title={title}
      chromeMeta={live ? "live" : entries.length}
      copyText={copyText}
      testID="workflow-run-event-log"
    >
      <View style={styles.logViewportWrapper}>
        <ScrollView
          ref={scrollRef}
          style={styles.logViewport}
          contentContainerStyle={styles.logViewportContent}
          nestedScrollEnabled
          onScroll={handleScroll}
          scrollEventThrottle={100}
        >
          {entries.length === 0 ? (
            <Text style={styles.logPlaceholder}>{`# ${placeholder}`}</Text>
          ) : (
            entries.map((entry) => (
              <Text key={entry.seq} style={styles.logLine}>
                <Text style={styles.logTime}>{formatLogTime(entry.ts)}</Text>
                <Text style={styles.logGap}> </Text>
                <Text style={logLevelStyle(entry.level)}>{formatLogLevel(entry.level)}</Text>
                <Text style={styles.logGap}> </Text>
                <Text style={styles.logEvent}>{entry.event}</Text>
                <Text style={styles.logGap}> </Text>
                <Text
                  style={
                    entry.level === "error" || entry.level === "warn"
                      ? styles.logMessageError
                      : styles.logMessage
                  }
                >
                  {entry.message}
                </Text>
              </Text>
            ))
          )}
        </ScrollView>
        {showJumpToBottom && entries.length > 0 ? (
          <Pressable
            onPress={jumpToBottom}
            style={styles.logJumpToBottom}
            testID="workflow-run-logs-jump-to-bottom"
          >
            <Text style={styles.logJumpToBottomText}>{t("workflows.runLogsJumpToLatest")}</Text>
          </Pressable>
        ) : null}
      </View>
      {hasMore ? (
        <Pressable
          onPress={onLoadMore}
          disabled={isFetchingMore}
          style={styles.logFooter}
          testID="workflow-run-logs-load-more"
        >
          <Text style={styles.logFooterText}>{isFetchingMore ? loadingLabel : loadMoreLabel}</Text>
        </Pressable>
      ) : null}
    </WorkflowDetailPanel>
  );
}

function formatLogLevel(level: string): string {
  switch (level) {
    case "error":
      return "ERR ";
    case "warn":
      return "WARN";
    case "debug":
      return "DBG ";
    default:
      return "INFO";
  }
}

function logLevelStyle(level: string) {
  switch (level) {
    case "error":
      return styles.logLevelError;
    case "warn":
      return styles.logLevelWarn;
    case "debug":
      return styles.logLevelDebug;
    default:
      return styles.logLevelInfo;
  }
}

function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const styles = StyleSheet.create((theme) => ({
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  runList: {
    gap: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  runRowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  errorText: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
  runStatusFailed: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    width: 72,
  },
  detailStack: { gap: theme.spacing[3] },
  phaseTree: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  phaseGroup: { gap: theme.spacing[1] },
  phaseTitle: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  phaseAgentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
  },
  phaseAgentLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  phaseAgentMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  phaseDotRunning: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.terminal.cyan,
  },
  phaseDotRetrying: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.terminal.yellow,
  },
  phaseDotDone: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.terminal.green,
  },
  phaseDotError: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.terminal.red,
  },
  detailSection: { gap: theme.spacing[2] },
  detailSectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  detailBody: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detailHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.45),
  },
  logPanel: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  detailPanelBody: {},
  detailPanelPadded: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  detailJsonViewport: {
    minHeight: 96,
    maxHeight: 280,
  },
  copyButton: {
    padding: theme.spacing[1],
  },
  copyButtonDisabled: {
    padding: theme.spacing[1],
    opacity: 0.4,
  },
  copyIcon: {
    color: theme.colors.foregroundMuted,
  },
  logChrome: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  logChromeTitle: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  logChromeRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  logChromeCount: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  logLivePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  logLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.terminal.green,
  },
  logLiveText: {
    color: theme.colors.terminal.green,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  logViewportWrapper: {
    position: "relative",
  },
  logViewport: {
    minHeight: 180,
    maxHeight: 360,
  },
  logJumpToBottom: {
    position: "absolute",
    bottom: theme.spacing[2],
    alignSelf: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accentBright,
  },
  logJumpToBottomText: {
    color: theme.colors.background,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  logViewportContent: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: 2,
  },
  logPlaceholder: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.5),
  },
  logLine: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.5),
  },
  logGap: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  logTime: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  logLevelInfo: {
    color: theme.colors.terminal.cyan,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  logLevelWarn: {
    color: theme.colors.terminal.yellow,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  logLevelError: {
    color: theme.colors.terminal.red,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  logLevelDebug: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  logEvent: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  logMessage: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  logMessageError: {
    color: theme.colors.terminal.red,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  logFooter: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  logFooterText: {
    color: theme.colors.accentBright,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  debugToggle: {
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1],
  },
  debugToggleText: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.sm,
  },
  detailMono: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
}));
