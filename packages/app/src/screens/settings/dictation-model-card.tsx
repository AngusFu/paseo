import { Check } from "lucide-react-native";
import type { TFunction } from "i18next";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import type { DictationModelInfo } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { SettingsSection } from "./settings-section";

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
  const queryKey = ["dictation-models", serverId] as const;
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
  return { query, queryKey, supported, client, isConnected };
}

export function DictationModelCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [trackingModelIds, setTrackingModelIds] = useState<Set<string>>(() => new Set());
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const forcePoll = trackingModelIds.size > 0 || pendingModel !== null;
  const { query, queryKey, supported, client, isConnected } = useDictationModels(serverId, {
    forcePoll,
  });

  const models = query.data?.models ?? EMPTY_DICTATION_MODELS;
  const currentModel = query.data?.current.model ?? null;
  const currentProvider = query.data?.current.provider ?? null;
  const readiness = query.data?.readiness ?? null;
  const usingNonLocalProvider = Boolean(currentProvider && currentProvider !== "local");

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

  if (!isConnected) {
    return null;
  }

  if (!supported) {
    return (
      <SettingsSection
        title={t("settings.host.dictation.title")}
        testID="host-page-dictation-model-card"
      >
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowHint}>{t("settings.host.dictation.unsupported")}</Text>
            </View>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t("settings.host.dictation.title")}
      testID="host-page-dictation-model-card"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowHint}>{t("settings.host.dictation.hint")}</Text>
            {usingNonLocalProvider ? (
              <Text style={settingsStyles.rowHint} testID="host-page-dictation-cloud-provider-hint">
                {t("settings.host.dictation.cloudProviderHint", { provider: currentProvider })}
              </Text>
            ) : null}
            {query.isError ? (
              <Text style={settingsStyles.rowError} testID="host-page-dictation-load-error">
                {query.error instanceof Error
                  ? query.error.message
                  : t("settings.host.dictation.loadError")}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={styles.dictationList}>
          {query.isLoading && models.length === 0 ? (
            <Text style={styles.dictationOptionStatus}>{t("settings.host.dictation.loading")}</Text>
          ) : (
            models.map((model) => {
              const selected = model.id === currentModel && !usingNonLocalProvider;
              const optimistic = trackingModelIds.has(model.id) && model.installed !== true;
              const downloading = isDictationModelDownloading({
                model,
                selected: model.id === currentModel,
                readinessDownloading: readiness?.downloading === true,
                missingModelIds: readiness?.missingModelIds ?? [],
                readinessAvailable: readiness?.available === true,
                optimistic,
              });
              const progress = resolveDictationDownloadProgress({
                model,
                selected: model.id === currentModel,
                downloading,
                readinessProgress: readiness?.downloadProgress,
                optimistic,
              });
              const speed = resolveDictationDownloadSpeed({
                model,
                selected: model.id === currentModel,
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
    </SettingsSection>
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
  const speedLabel = formatDictationDownloadSpeed(bytesPerSecond);

  return (
    <View style={styles.dictationProgressWrap} testID={`dictation-model-progress-${modelId}`}>
      <View style={styles.dictationProgressTrack}>
        <View style={[styles.dictationProgressFill, { width: `${percent}%` as `${number}%` }]} />
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
  const accessibilityState = selected
    ? ACCESSIBILITY_STATE_SELECTED
    : ACCESSIBILITY_STATE_UNSELECTED;

  const installed = model.installed || (selected && readinessAvailable && !downloading);
  const percent =
    downloadProgress === null ? null : Math.max(0, Math.min(100, Math.round(downloadProgress)));
  const showProgress = downloading || percent !== null;
  const runState = resolveDictationRunState(selected, readinessAvailable);

  let statusText: string;
  if (showProgress) {
    // Percent + speed live on the progress bar; keep the line quiet.
    statusText = t("settings.host.dictation.downloading");
  } else if (!installed) {
    statusText = t("settings.host.dictation.notInstalled");
  } else if (selected) {
    statusText = dictationRunStateLabel(t, runState);
  } else {
    statusText = t("settings.host.dictation.available");
  }

  let action: ReactNode = null;
  if (pending) {
    action = <ThemedActivityIndicator uniProps={mutedColorMapping} />;
  } else if (showProgress) {
    action = (
      <DictationDownloadProgress
        modelId={model.id}
        percent={percent ?? 0}
        bytesPerSecond={downloadBytesPerSecond}
      />
    );
  } else if (!installed) {
    action = (
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
  } else if (selected) {
    action = (
      <View style={styles.dictationTrailingActions}>
        <StatusBadge
          label={dictationRunStateLabel(t, runState)}
          variant={runState === "running" ? "success" : "muted"}
        />
        <View style={styles.dictationAppliedBadge} accessibilityRole="text">
          <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />
          <Text style={styles.dictationAppliedText}>{t("settings.host.dictation.applied")}</Text>
        </View>
      </View>
    );
  } else {
    action = (
      <Button
        size="sm"
        variant="secondary"
        onPress={handleApply}
        accessibilityLabel={t("settings.host.dictation.apply")}
        testID={`dictation-model-apply-${model.id}`}
      >
        {t("settings.host.dictation.apply")}
      </Button>
    );
  }

  return (
    <View
      style={[styles.dictationOption, selected && styles.dictationOptionSelected]}
      accessibilityState={accessibilityState}
      testID={`dictation-model-row-${model.id}`}
    >
      <View style={styles.dictationOptionTop}>
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
        {!showProgress ? <View style={styles.dictationActionSlot}>{action}</View> : null}
      </View>
      {showProgress ? action : null}
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
    gap: theme.spacing[2],
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
  dictationOptionTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  dictationOptionContent: {
    flex: 1,
    gap: theme.spacing[1],
    minWidth: 0,
  },
  dictationOptionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
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
  dictationActionSlot: {
    flexShrink: 0,
  },
  dictationTrailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  dictationProgressWrap: {
    width: "100%",
    gap: theme.spacing[1],
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
