/**
 * Live monitor for a workflow run: header counters, a phase list on the left
 * and the selected phase's agent calls on the right, plus an action bar. The
 * two columns stack once the container itself gets narrow — the monitor also
 * renders inside the run-detail sheet, which is narrow on a desktop.
 *
 * Everything here is derived from the run record and the event log the detail
 * body already polls once a second — no extra network. The elapsed timers are
 * computed client-side off a 1s tick that only runs while the run is live.
 *
 * Deliberately absent: token counts, provider, context window and idle time.
 * The engine's `agent.done` events carry no `callId`, so those numbers cannot
 * be attached to a tree node yet; rendering permanent placeholder dashes would
 * imply data we do not have.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { WorkflowLogEntry, WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import {
  buildWorkflowPhaseTree,
  formatWorkflowElapsed,
  resolveAgentElapsedMs,
  resolveCurrentPhaseIndex,
  resolveRunElapsedMs,
  summarizeWorkflowPhases,
  type PhaseAgentStatus,
  type PhaseTreeGroup,
} from "@/screens/workflow-run-phase-tree";

const TICK_INTERVAL_MS = 1_000;

/**
 * Below this the two columns no longer fit: the 220px phase column plus a
 * readable agent row. Measured on the columns container, not the device — the
 * monitor also renders inside the narrow run-detail sheet and in split panes,
 * both of which stay non-compact form factors.
 */
const TWO_COLUMN_MIN_WIDTH = 480;

/** Re-renders once a second while `enabled`, so elapsed timers advance. */
function useElapsedTick(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return nowMs;
}

/**
 * Arrow-key phase selection and the stop shortcut. Web only — native has no
 * hardware keyboard to rely on, so the compact layout gets buttons instead.
 * Ignores keys typed into a field so it never steals from an input.
 */
function usePhaseShortcuts(input: {
  enabled: boolean;
  phaseCount: number;
  onMove: (delta: number) => void;
  onStop: (() => void) | undefined;
}): void {
  const { enabled, phaseCount, onMove, onStop } = input;
  useEffect(() => {
    if (!isWeb || !enabled || phaseCount === 0) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        onMove(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        onMove(-1);
        return;
      }
      if (event.key === "x" && onStop) {
        event.preventDefault();
        onStop();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onMove, onStop, phaseCount]);
}

export function WorkflowRunMonitor({
  run,
  runName,
  description,
  entries,
  live,
  keyboardEnabled = false,
  onStop,
}: {
  run: WorkflowRun;
  /** Workflow name for the header; falls back to a generic label. */
  runName: string | null;
  description: string | null;
  entries: WorkflowLogEntry[];
  live: boolean;
  /** Enable the web key handler — pass the pane's focus state. */
  keyboardEnabled?: boolean;
  onStop?: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { onLayout: onColumnsLayout, isBelow: isNarrow } =
    useContainerWidthBelow(TWO_COLUMN_MIN_WIDTH);
  const groups = useMemo(() => buildWorkflowPhaseTree(entries), [entries]);
  const summaries = useMemo(() => summarizeWorkflowPhases(groups), [groups]);
  const currentPhaseIndex = useMemo(() => resolveCurrentPhaseIndex(groups), [groups]);
  const nowMs = useElapsedTick(live);

  // Selection follows the engine until the user picks a phase themselves.
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const selectedIndex =
    pinnedIndex !== null && pinnedIndex < groups.length ? pinnedIndex : currentPhaseIndex;

  const handleMove = useCallback(
    (delta: number) => {
      setPinnedIndex((current) => {
        const from = current ?? currentPhaseIndex;
        const next = from + delta;
        if (next < 0 || next >= groups.length) {
          return current;
        }
        return next;
      });
    },
    [currentPhaseIndex, groups.length],
  );

  usePhaseShortcuts({
    enabled: keyboardEnabled && !isCompact,
    phaseCount: groups.length,
    onMove: handleMove,
    onStop,
  });

  const totals = useMemo(
    () =>
      summaries.reduce(
        (acc, summary) => ({ done: acc.done + summary.done, total: acc.total + summary.total }),
        { done: 0, total: 0 },
      ),
    [summaries],
  );

  // Older daemons emit no callId-tagged entries, so there is no tree to show.
  if (groups.length === 0) {
    return null;
  }

  const selectedGroup: PhaseTreeGroup | null = groups[selectedIndex] ?? null;
  const runElapsed = formatWorkflowElapsed(resolveRunElapsedMs(run, nowMs));

  return (
    <View style={styles.monitor} testID="workflow-run-monitor">
      <View style={styles.header}>
        <View style={styles.headerTitles}>
          <Text style={styles.runName} numberOfLines={1}>
            {runName || t("workflows.runTabLabel")}
          </Text>
          {description ? (
            <Text style={styles.runDescription} numberOfLines={2}>
              {description}
            </Text>
          ) : null}
        </View>
        <Text style={styles.headerMeta} testID="workflow-run-monitor-counters">
          {t("workflows.monitorAgentCount", { done: totals.done, total: totals.total })}
          {" · "}
          {runElapsed}
        </Text>
      </View>

      <View style={isNarrow ? styles.columnsStacked : styles.columns} onLayout={onColumnsLayout}>
        <View style={isNarrow ? styles.phaseColumnStacked : styles.phaseColumn}>
          <Text style={styles.columnLabel}>{t("workflows.runPhases")}</Text>
          {groups.map((group, index) => (
            <PhaseRow
              key={group.title ?? `__ungrouped_${index}`}
              index={index}
              title={group.title ?? t("workflows.runPhaseUngrouped")}
              done={summaries[index]?.done ?? 0}
              total={summaries[index]?.total ?? 0}
              isSelected={index === selectedIndex}
              onSelect={setPinnedIndex}
            />
          ))}
        </View>

        <View style={styles.agentColumn}>
          <Text style={styles.columnLabel} numberOfLines={1}>
            {selectedGroup?.title ?? t("workflows.runPhaseUngrouped")}
          </Text>
          {selectedGroup && selectedGroup.agents.length > 0 ? (
            selectedGroup.agents.map((agent) => (
              <View key={agent.callId} style={styles.agentRow}>
                <View style={agentDotStyle(agent.status)} />
                <Text style={styles.agentLabel} numberOfLines={1}>
                  {agent.label ?? t("workflows.monitorAgentFallback", { callId: agent.callId })}
                </Text>
                {agent.model ? <Text style={styles.agentModel}>{agent.model}</Text> : null}
                {agent.cached ? (
                  <Text style={styles.agentModel}>{t("workflows.runPhaseCached")}</Text>
                ) : null}
                <Text style={styles.agentElapsed}>
                  {formatWorkflowElapsed(resolveAgentElapsedMs(agent, nowMs))}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.emptyPhase}>{t("workflows.monitorPhaseEmpty")}</Text>
          )}
        </View>
      </View>

      <MonitorActionBar isCompact={isCompact} canStop={Boolean(onStop) && live} onStop={onStop} />
    </View>
  );
}

function PhaseRow({
  index,
  title,
  done,
  total,
  isSelected,
  onSelect,
}: {
  index: number;
  title: string;
  done: number;
  total: number;
  isSelected: boolean;
  onSelect: (index: number) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(index), [index, onSelect]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selectedState(isSelected)}
      accessibilityLabel={title}
      onPress={handlePress}
      style={isSelected ? styles.phaseRowSelected : styles.phaseRow}
      testID={`workflow-run-monitor-phase-${index}`}
    >
      <Text style={isSelected ? styles.phaseMarkerActive : styles.phaseMarker}>
        {isSelected ? "›" : " "}
      </Text>
      <Text style={styles.phaseIndex}>{index + 1}</Text>
      <Text style={isSelected ? styles.phaseTitleActive : styles.phaseTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.phaseCount}>{`${done}/${total}`}</Text>
    </Pressable>
  );
}

function selectedState(selected: boolean) {
  return { selected };
}

/**
 * Web shows the key hints; compact shows a real button. Pause, save and back
 * from the wireframe are not rendered — none of those actions exist here, and
 * a hint for a key that does nothing is worse than no hint.
 */
function MonitorActionBar({
  isCompact,
  canStop,
  onStop,
}: {
  isCompact: boolean;
  canStop: boolean;
  onStop: (() => void) | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!onStop) {
    return null;
  }

  if (isCompact) {
    return (
      <View style={styles.actionBar} testID="workflow-run-monitor-actions">
        <Pressable
          accessibilityRole="button"
          disabled={!canStop}
          onPress={onStop}
          style={canStop ? styles.actionButton : styles.actionButtonDisabled}
          testID="workflow-run-monitor-stop"
        >
          <Text style={styles.actionButtonText}>{t("workflows.monitorStop")}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.actionBar} testID="workflow-run-monitor-actions">
      <Text style={styles.actionHint}>{t("workflows.monitorHintSelect")}</Text>
      {canStop ? <Text style={styles.actionHint}>{t("workflows.monitorHintStop")}</Text> : null}
    </View>
  );
}

function agentDotStyle(status: PhaseAgentStatus) {
  if (status === "done") return styles.agentDotDone;
  if (status === "error") return styles.agentDotError;
  if (status === "retrying") return styles.agentDotRetrying;
  if (status === "queued") return styles.agentDotQueued;
  return styles.agentDotRunning;
}

const DOT = { width: 8, height: 8, borderRadius: 4 } as const;

const styles = StyleSheet.create((theme) => ({
  monitor: {
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  headerTitles: { flexShrink: 1, gap: theme.spacing[1] },
  runName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  runDescription: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  headerMeta: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  columns: { flexDirection: "row", gap: theme.spacing[4] },
  columnsStacked: { flexDirection: "column", gap: theme.spacing[3] },
  phaseColumn: {
    width: 220,
    gap: theme.spacing[1],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    paddingRight: theme.spacing[3],
  },
  phaseColumnStacked: { gap: theme.spacing[1] },
  agentColumn: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  columnLabel: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: theme.spacing[1],
  },
  phaseRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  phaseRowSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  phaseMarker: { color: "transparent", fontFamily: theme.fontFamily.mono, fontSize: 12, width: 8 },
  phaseMarkerActive: {
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
    fontSize: 12,
    width: 8,
  },
  phaseIndex: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  phaseTitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flex: 1 },
  phaseTitleActive: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  phaseCount: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  agentLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1, minWidth: 0 },
  agentModel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  agentElapsed: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    textAlign: "right",
    minWidth: 56,
  },
  emptyPhase: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
  },
  actionHint: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  actionButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionButtonDisabled: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    opacity: 0.5,
  },
  actionButtonText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  agentDotQueued: { ...DOT, backgroundColor: theme.colors.foregroundMuted },
  agentDotRunning: { ...DOT, backgroundColor: theme.colors.terminal.cyan },
  agentDotRetrying: { ...DOT, backgroundColor: theme.colors.terminal.yellow },
  agentDotDone: { ...DOT, backgroundColor: theme.colors.terminal.green },
  agentDotError: { ...DOT, backgroundColor: theme.colors.terminal.red },
}));
