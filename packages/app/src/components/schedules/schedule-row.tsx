import {
  MoreVertical,
  Pause,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
  Trash2,
  Zap,
} from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getProviderIcon } from "@/components/provider-icons";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { ScheduleDerivedState } from "@/schedules/schedule-derivation";
import { formatCadence, formatNextRun, resolveScheduleTitle } from "@/utils/schedule-format";
import { formatTimeAgo } from "@/utils/time";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

// Themed lucide wrappers — module-scope so only the icon re-renders on theme
// change (never call useUnistyles in render). See docs/unistyles.md.
const ThemedPencil = withUnistyles(Pencil);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedScrollText = withUnistyles(ScrollText);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedZap = withUnistyles(Zap);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const runIconEnabledMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const runIconDisabledMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MENU_ICON_SIZE = 14;
const PROVIDER_ICON_SIZE = 16;

// Pending flags for each action so the parent table can wire a mutation hook
// and the row reflects in-flight state without owning the mutation itself.
export interface ScheduleRowPending {
  pause?: boolean;
  resume?: boolean;
  runNow?: boolean;
  delete?: boolean;
}

export interface ScheduleRowActions {
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRunNow: () => void;
  onViewLogs: () => void;
  onDelete: () => void;
}

interface ScheduleRowProps extends ScheduleRowActions {
  schedule: ScheduleSummary;
  /** Client-derived target line (agent title / project / shortened path). */
  targetLabel: string;
  /** Provider glyph, resolved from the schedule config or the target agent. */
  provider: string | null;
  /** Client-derived state — the single source for the badge and next-run copy. */
  state: ScheduleDerivedState;
  /** Host name, rendered when the list spans more than one host. */
  serverName?: string;
  /** True when only one host exists and the host name would be redundant. */
  singleHost?: boolean;
  pending?: ScheduleRowPending;
  isFirst: boolean;
}

function stateBadge(state: ScheduleDerivedState): {
  labelKey: string;
  variant: "success" | "error" | "muted";
} {
  switch (state) {
    case "active":
      return { labelKey: "schedule.state.active", variant: "success" };
    case "paused":
      return { labelKey: "schedule.state.paused", variant: "muted" };
    case "expired":
      return { labelKey: "schedule.state.expired", variant: "muted" };
    case "finished":
      return { labelKey: "schedule.state.finished", variant: "muted" };
    case "targetGone":
      return { labelKey: "schedule.state.targetGone", variant: "error" };
  }
}

// Meta reads left-to-right as identity → history → future: how often, when it
// was created, when it last ran, and (only while it can still run) when it runs
// next. Status lives on the badge, never repeated here.
function buildMeta(
  schedule: ScheduleSummary,
  state: ScheduleDerivedState,
  serverName: string | undefined,
  singleHost: boolean,
  t: TFunction,
): string {
  const parts = [
    formatCadence(schedule.cadence),
    t("schedule.meta.created", { time: formatTimeAgo(new Date(schedule.createdAt)) }),
    schedule.lastRunAt
      ? t("schedule.meta.lastRun", { time: formatTimeAgo(new Date(schedule.lastRunAt)) })
      : t("schedule.meta.neverRun"),
  ];
  if (state === "active") {
    const next = formatNextRun(schedule.nextRunAt);
    if (next) {
      parts.push(t("schedule.meta.nextRun", { next }));
    }
  }
  if (serverName && !singleHost) {
    parts.unshift(serverName);
  }
  return parts.join(" · ");
}

/** Small provider glyph. Reads the icon color off a StyleSheet object so the
 * dynamic component (getProviderIcon) stays compliant without useUnistyles. */
function ProviderGlyph({ provider }: { provider: string | null }): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={PROVIDER_ICON_SIZE} color={styles.providerIcon.color} />;
}

/**
 * One schedule, rendered as a settings-style card row: provider glyph + title,
 * a muted secondary line (model · cadence · next run), a StatusBadge, and the
 * kebab menu that owns every row action. Tapping the row opens the editor.
 *
 * Hover lives on the outer plain View (docs/hover.md): the inner Pressable owns
 * press, the nested kebab Pressable never fights it, and the row background
 * highlights without reflow.
 */
export function ScheduleRow({
  schedule,
  targetLabel,
  provider,
  state,
  serverName,
  singleHost,
  pending,
  isFirst,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onViewLogs,
  onDelete,
}: ScheduleRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const title = resolveScheduleTitle(schedule);
  const badge = stateBadge(state);
  const meta = buildMeta(schedule, state, serverName, singleHost ?? false, t);
  const canRun = state === "active" || state === "paused";

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      isHovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact],
  );

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel={t("schedule.menu.editA11y", { title })}
        testID={`schedule-row-${schedule.id}`}
      >
        <View style={styles.main}>
          <View style={styles.leading}>
            <ProviderGlyph provider={provider} />
          </View>
          <View style={styles.textGroup}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.target} numberOfLines={1}>
              {targetLabel}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {meta}
            </Text>
          </View>
        </View>

        <View style={styles.trailing}>
          <ScheduleRunButton
            scheduleId={schedule.id}
            canRun={canRun}
            pending={pending?.runNow ?? false}
            onRunNow={onRunNow}
          />
          <StatusBadge label={t(badge.labelKey)} variant={badge.variant} />
          <ScheduleKebabMenu
            schedule={schedule}
            canRun={canRun}
            pending={pending}
            onEdit={onEdit}
            onPause={onPause}
            onResume={onResume}
            onRunNow={onRunNow}
            onViewLogs={onViewLogs}
            onDelete={onDelete}
          />
        </View>
      </Pressable>
    </View>
  );
}

const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const pauseLeading = <ThemedPause size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const resumeLeading = <ThemedPlay size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const runLeading = <ThemedRotateCw size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const logsLeading = <ThemedScrollText size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash2 size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

const RUN_BUTTON_ICON_SIZE = 15;

// Row-level instant trigger. A nested Pressable so its tap fires runNow without
// bubbling to the row's edit press (same trick the kebab uses). Disabled while a
// run is in flight or the schedule cannot run; shows a spinner mid-flight.
function ScheduleRunButton({
  scheduleId,
  canRun,
  pending,
  onRunNow,
}: {
  scheduleId: string;
  canRun: boolean;
  pending: boolean;
  onRunNow: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const disabled = !canRun || pending;
  const handlePress = useCallback(() => {
    if (!disabled) {
      onRunNow();
    }
  }, [disabled, onRunNow]);

  // Icon stays muted at rest and brightens to full foreground on hover, so the
  // button visibly reacts even though its hover background sits close to the
  // row's own hover tint.
  const renderIcon = useCallback(
    ({ hovered }: { hovered?: boolean }): ReactElement =>
      pending ? (
        <LoadingSpinner size="small" color={styles.runIcon.color} />
      ) : (
        <ThemedZap
          size={RUN_BUTTON_ICON_SIZE}
          uniProps={!disabled && hovered ? runIconEnabledMapping : runIconDisabledMapping}
        />
      ),
    [pending, disabled],
  );

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      hitSlop={8}
      style={runButtonStyle}
      accessibilityRole="button"
      accessibilityLabel={t("schedule.menu.runNow")}
      testID={`schedule-run-${scheduleId}`}
    >
      {renderIcon}
    </Pressable>
  );
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

function ScheduleKebabMenu({
  schedule,
  canRun,
  pending,
  onEdit,
  onPause,
  onResume,
  onRunNow,
  onViewLogs,
  onDelete,
}: Pick<
  ScheduleRowProps,
  | "schedule"
  | "pending"
  | "onEdit"
  | "onPause"
  | "onResume"
  | "onRunNow"
  | "onViewLogs"
  | "onDelete"
> & {
  canRun: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel={t("schedule.menu.actions")}
        testID={`schedule-kebab-${schedule.id}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        <DropdownMenuItem
          leading={editLeading}
          onSelect={onEdit}
          testID={`schedule-menu-edit-${schedule.id}`}
        >
          {t("schedule.menu.edit")}
        </DropdownMenuItem>
        {schedule.status === "paused" ? (
          <DropdownMenuItem
            leading={resumeLeading}
            disabled={!canRun}
            status={pending?.resume ? "pending" : "idle"}
            pendingLabel={t("schedule.menu.resuming")}
            onSelect={onResume}
            testID={`schedule-menu-resume-${schedule.id}`}
          >
            {t("schedule.menu.resume")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            leading={pauseLeading}
            disabled={schedule.status === "completed" || !canRun}
            status={pending?.pause ? "pending" : "idle"}
            pendingLabel={t("schedule.menu.pausing")}
            onSelect={onPause}
            testID={`schedule-menu-pause-${schedule.id}`}
          >
            {t("schedule.menu.pause")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          leading={runLeading}
          disabled={!canRun}
          status={pending?.runNow ? "pending" : "idle"}
          pendingLabel={t("common.states.starting")}
          onSelect={onRunNow}
          testID={`schedule-menu-run-${schedule.id}`}
        >
          {t("schedule.menu.runNow")}
        </DropdownMenuItem>
        <DropdownMenuItem
          leading={logsLeading}
          onSelect={onViewLogs}
          testID={`schedule-menu-logs-${schedule.id}`}
        >
          {t("schedule.menu.viewLogs")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          status={pending?.delete ? "pending" : "idle"}
          pendingLabel={t("schedule.menu.deleting")}
          onSelect={onDelete}
          testID={`schedule-menu-delete-${schedule.id}`}
        >
          {t("schedule.menu.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

function runButtonStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.runButton, (hovered || pressed) && styles.runButtonHovered];
}

const styles = StyleSheet.create((theme) => ({
  // Static color holder for the dynamic provider icon (compliant idiom).
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  leading: {
    width: PROVIDER_ICON_SIZE,
    height: PROVIDER_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  target: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  // Static color holder read by the run-button spinner (compliant idiom).
  runIcon: {
    color: theme.colors.foreground,
  },
  runButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    alignItems: "center",
    justifyContent: "center",
  },
  runButtonHovered: {
    backgroundColor: theme.colors.surface4,
  },
}));
