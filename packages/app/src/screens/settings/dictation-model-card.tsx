import { Check } from "lucide-react-native";
import type { TFunction } from "i18next";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import type { DictationModelInfo } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Strip parenthetical notes (and any trailing period) from a model description for display. */
function cleanDictationLabel(description: string): string {
  return description
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

const DICTATION_DOWNLOAD_POLL_MS = 500;
const EMPTY_DICTATION_MODELS: DictationModelInfo[] = [];
const ACCESSIBILITY_STATE_SELECTED = { selected: true } as const;
const ACCESSIBILITY_STATE_UNSELECTED = { selected: false } as const;

type DictationRunState = "running" | "starting" | "stopped";

function resolveDictationRunState(
  selected: boolean,
  readinessAvailable: boolean,
): DictationRunState {
  if (selected && readinessAvailable) return "running";
  if (selected) return "starting";
  return "stopped";
}

function dictationRunStateLabel(t: TFunction, state: DictationRunState): string {
  if (state === "running") return t("settings.host.dictation.running");
  if (state === "starting") return t("settings.host.dictation.starting");
  return t("settings.host.dictation.stopped");
}

function formatDictationDownloadSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "—";
  }
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  }
  return `${Math.round(bytesPerSecond)} B/s`;
}

function resolveDictationDownloadProgress(params: {
  model: DictationModelInfo;
  selected: boolean;
  downloading: boolean;
  readinessProgress: number | undefined;
  optimistic: boolean;
}): number | null {
  if (typeof params.model.downloadProgress === "number") {
    return params.model.downloadProgress;
  }
  if (params.selected && typeof params.readinessProgress === "number") {
    return params.readinessProgress;
  }
  if (params.downloading || params.optimistic) {
    return 0;
  }
  return null;
}

function resolveDictationDownloadSpeed(params: {
  model: DictationModelInfo;
  selected: boolean;
  readinessSpeed: number | undefined;
}): number {
  if (typeof params.model.downloadBytesPerSecond === "number") {
    return params.model.downloadBytesPerSecond;
  }
  if (params.selected && typeof params.readinessSpeed === "number") {
    return params.readinessSpeed;
  }
  return 0;
}

function isDictationModelDownloading(params: {
  model: DictationModelInfo;
  selected: boolean;
  readinessDownloading: boolean;
  missingModelIds: string[];
  readinessAvailable: boolean;
  optimistic: boolean;
}): boolean {
  if (params.optimistic) {
    return true;
  }
  if (params.model.downloading === true) {
    return true;
  }
  if (!params.selected || !params.readinessDownloading) {
    return false;
  }
  return params.missingModelIds.includes(params.model.id) || !params.readinessAvailable;
}

function useDictationModels(
  serverId: string,
  options: {
    forcePoll: boolean;
  },
) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.dictationModelSelection === true,
  );
  const queryKey = useMemo(() => ["dictation-models", serverId] as const, [serverId]);
  const forcePoll = options.forcePoll;
  const query = useFetchQuery({
    queryKey,
    enabled: Boolean(client && isConnected && supported),
    dataShape: "list",
    staleTimeMs: forcePoll ? 0 : 5_000,
    refetchInterval: (queryState) => {
      if (forcePoll) {
        return DICTATION_DOWNLOAD_POLL_MS;
      }
      const data = queryState.state.data;
      if (!data) {
        return false;
      }
      if (data.readiness?.downloading === true) {
        return DICTATION_DOWNLOAD_POLL_MS;
      }
      if (
        data.models.some(
          (model) => model.downloading === true || typeof model.downloadProgress === "number",
        )
      ) {
        return DICTATION_DOWNLOAD_POLL_MS;
      }
      if (
        data.models.some((model) => model.id === data.current.model && model.installed !== true)
      ) {
        return DICTATION_DOWNLOAD_POLL_MS;
      }
      return false;
    },
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return client.listDictationModels();
    },
  });
  return { query, queryKey, supported, client };
}

export function DictationModelCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [trackingModelIds, setTrackingModelIds] = useState<Set<string>>(() => new Set());
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const forcePoll = trackingModelIds.size > 0 || pendingModel !== null;
  const { query, queryKey, supported, client } = useDictationModels(serverId, { forcePoll });

  const models = query.data?.models ?? EMPTY_DICTATION_MODELS;
  const currentModel = query.data?.current.model ?? null;
  const readiness = query.data?.readiness ?? null;

  useEffect(() => {
    if (trackingModelIds.size === 0) {
      return;
    }
    const snapshotModels = query.data?.models;
    if (!snapshotModels) {
      return;
    }
    setTrackingModelIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        const model = snapshotModels.find((entry) => entry.id === id);
        if (!model || model.installed) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [query.data?.models, trackingModelIds.size]);

  const handleApply = useCallback(
    (modelId: string) => {
      if (!client) {
        return;
      }
      setPendingModel(modelId);
      setTrackingModelIds((prev) => new Set(prev).add(modelId));
      void (async () => {
        try {
          await client.setDictationModel(modelId);
          await queryClient.invalidateQueries({ queryKey });
        } catch (error) {
          setTrackingModelIds((prev) => {
            const next = new Set(prev);
            next.delete(modelId);
            return next;
          });
          Alert.alert(
            t("settings.host.dictation.selectErrorTitle"),
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          setPendingModel(null);
        }
      })();
    },
    [client, queryClient, queryKey, t],
  );

  if (!supported) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-dictation-model-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.dictation.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.dictation.hint")}</Text>
        </View>
      </View>
      <View style={styles.dictationList}>
        {query.isLoading && models.length === 0 ? (
          <Text style={styles.dictationOptionStatus}>{t("settings.host.dictation.loading")}</Text>
        ) : (
          models.map((model) => {
            const selected = model.id === currentModel;
            const optimistic = trackingModelIds.has(model.id) && model.installed !== true;
            const downloading = isDictationModelDownloading({
              model,
              selected,
              readinessDownloading: readiness?.downloading === true,
              missingModelIds: readiness?.missingModelIds ?? [],
              readinessAvailable: readiness?.available === true,
              optimistic,
            });
            const progress = resolveDictationDownloadProgress({
              model,
              selected,
              downloading,
              readinessProgress: readiness?.downloadProgress,
              optimistic,
            });
            const speed = resolveDictationDownloadSpeed({
              model,
              selected,
              readinessSpeed: readiness?.downloadBytesPerSecond,
            });

            return (
              <DictationModelRow
                key={model.id}
                model={model}
                selected={selected}
                pending={pendingModel === model.id}
                downloading={downloading}
                downloadProgress={progress}
                downloadBytesPerSecond={speed}
                readinessAvailable={readiness?.available === true}
                onApply={handleApply}
              />
            );
          })
        )}
      </View>
    </View>
  );
}

function DictationDownloadProgress({
  modelId,
  percent,
  bytesPerSecond,
}: {
  modelId: string;
  percent: number;
  bytesPerSecond: number;
}) {
  const { t } = useTranslation();
  const fillStyle = useMemo(
    () => [styles.dictationProgressFill, { width: `${percent}%` as `${number}%` }],
    [percent],
  );
  const speedLabel = formatDictationDownloadSpeed(bytesPerSecond);

  return (
    <View style={styles.dictationProgressWrap} testID={`dictation-model-progress-${modelId}`}>
      <View style={styles.dictationProgressTrack}>
        <View style={fillStyle} />
      </View>
      <View style={styles.dictationProgressMeta}>
        <Text style={styles.dictationProgressLabel}>{`${percent}%`}</Text>
        <Text style={styles.dictationProgressSpeed} numberOfLines={1}>
          {t("settings.host.dictation.downloadSpeed", { speed: speedLabel })}
        </Text>
      </View>
    </View>
  );
}

function DictationRunStatusPill({ state }: { state: DictationRunState }) {
  const { t } = useTranslation();
  const active = state === "running";
  const pillStyle = useMemo(
    () => [
      styles.dictationStatusPill,
      active ? styles.dictationStatusPillActive : styles.dictationStatusPillIdle,
    ],
    [active],
  );
  const textStyle = useMemo(
    () => [
      styles.dictationStatusPillText,
      active ? styles.dictationStatusPillTextActive : styles.dictationStatusPillTextIdle,
    ],
    [active],
  );

  return (
    <View style={pillStyle}>
      <Text style={textStyle}>{dictationRunStateLabel(t, state)}</Text>
    </View>
  );
}

function DictationInstalledTrailing({
  modelId,
  selected,
  readinessAvailable,
  onApply,
}: {
  modelId: string;
  selected: boolean;
  readinessAvailable: boolean;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const runState = resolveDictationRunState(selected, readinessAvailable);

  return (
    <View style={styles.dictationTrailingActions}>
      <DictationRunStatusPill state={runState} />
      {selected ? (
        <View style={styles.dictationAppliedBadge} accessibilityRole="text">
          <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />
          <Text style={styles.dictationAppliedText}>{t("settings.host.dictation.applied")}</Text>
        </View>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onPress={onApply}
          accessibilityLabel={t("settings.host.dictation.apply")}
          testID={`dictation-model-apply-${modelId}`}
        >
          {t("settings.host.dictation.apply")}
        </Button>
      )}
    </View>
  );
}

function DictationModelRow({
  model,
  selected,
  pending,
  downloading,
  downloadProgress,
  downloadBytesPerSecond,
  readinessAvailable,
  onApply,
}: {
  model: DictationModelInfo;
  selected: boolean;
  pending: boolean;
  downloading: boolean;
  downloadProgress: number | null;
  downloadBytesPerSecond: number;
  readinessAvailable: boolean;
  onApply: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  const handleApply = useCallback(() => onApply(model.id), [onApply, model.id]);
  const optionStyle = useMemo(
    () => [styles.dictationOption, selected && styles.dictationOptionSelected],
    [selected],
  );
  const accessibilityState = selected
    ? ACCESSIBILITY_STATE_SELECTED
    : ACCESSIBILITY_STATE_UNSELECTED;

  const installed = model.installed || (selected && readinessAvailable && !downloading);
  const percent =
    downloadProgress === null ? null : Math.max(0, Math.min(100, Math.round(downloadProgress)));
  const showProgress = downloading || percent !== null;
  const runState = resolveDictationRunState(selected, readinessAvailable);
  const speedLabel = formatDictationDownloadSpeed(downloadBytesPerSecond);

  let statusText: string;
  if (showProgress) {
    if (percent === null) {
      statusText = t("settings.host.dictation.downloading");
    } else {
      statusText = t("settings.host.dictation.downloadingPercentWithSpeed", {
        percent,
        speed: speedLabel,
      });
    }
  } else if (!installed) {
    statusText = t("settings.host.dictation.notInstalled");
  } else {
    statusText = dictationRunStateLabel(t, runState);
  }

  let trailing: ReactNode = null;
  if (pending) {
    trailing = <ThemedActivityIndicator uniProps={mutedColorMapping} />;
  } else if (showProgress) {
    trailing = (
      <DictationDownloadProgress
        modelId={model.id}
        percent={percent ?? 0}
        bytesPerSecond={downloadBytesPerSecond}
      />
    );
  } else if (!installed) {
    trailing = (
      <Button
        size="sm"
        variant="secondary"
        onPress={handleApply}
        accessibilityLabel={t("settings.host.dictation.download")}
        testID={`dictation-model-download-${model.id}`}
      >
        {t("settings.host.dictation.download")}
      </Button>
    );
  } else {
    trailing = (
      <DictationInstalledTrailing
        modelId={model.id}
        selected={selected}
        readinessAvailable={readinessAvailable}
        onApply={handleApply}
      />
    );
  }

  return (
    <View
      style={optionStyle}
      accessibilityState={accessibilityState}
      testID={`dictation-model-row-${model.id}`}
    >
      <View style={styles.dictationOptionContent}>
        <Text style={styles.dictationOptionTitle}>{cleanDictationLabel(model.description)}</Text>
        <View style={styles.dictationLangRow}>
          {model.languages.map((lang) => (
            <View key={lang} style={styles.dictationLangBadge}>
              <Text style={styles.dictationLangBadgeText}>{lang}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.dictationOptionStatus}>{statusText}</Text>
      </View>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dictationList: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[4],
  },
  dictationOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
  },
  dictationOptionSelected: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.surface3,
  },
  dictationOptionContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  dictationOptionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  dictationLangRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  dictationLangBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
  },
  dictationLangBadgeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  dictationOptionStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  dictationTrailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  dictationProgressWrap: {
    width: 128,
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  dictationProgressTrack: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  dictationProgressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foreground,
  },
  dictationProgressMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  dictationProgressLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
  dictationProgressSpeed: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
    flexShrink: 1,
  },
  dictationStatusPill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  dictationStatusPillActive: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.surface3,
  },
  dictationStatusPillIdle: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  dictationStatusPillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  dictationStatusPillTextActive: {
    color: theme.colors.foreground,
  },
  dictationStatusPillTextIdle: {
    color: theme.colors.foregroundMuted,
  },
  dictationAppliedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  dictationAppliedText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
}));
