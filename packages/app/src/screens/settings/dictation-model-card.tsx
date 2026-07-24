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

const DICTATION_DOWNLOAD_POLL_MS = 500;
const EMPTY_DICTATION_MODELS: DictationModelInfo[] = [];
const ACCESSIBILITY_STATE_SELECTED = { selected: true } as const;
const ACCESSIBILITY_STATE_UNSELECTED = { selected: false } as const;

const DICTATION_MODEL_TITLE_KEYS = {
  "sense-voice-zh-en-ja-ko-yue-int8": "settings.host.dictation.models.senseVoice",
  "parakeet-tdt-0.6b-v2-int8": "settings.host.dictation.models.parakeetV2",
  "parakeet-tdt-0.6b-v3-int8": "settings.host.dictation.models.parakeetV3",
} as const;

type DictationRunState = "running" | "starting" | "stopped";

function dictationModelTitle(t: TFunction, modelId: string, fallback: string): string {
  const key = DICTATION_MODEL_TITLE_KEYS[modelId as keyof typeof DICTATION_MODEL_TITLE_KEYS];
  if (!key) {
    return fallback;
  }
  return t(key);
}

function formatLanguages(t: TFunction, languages: readonly string[]): string {
  // Long European catalogs read as noise in a settings row; summarize instead.
  if (languages.length > 8) {
    return t("settings.host.dictation.languagesMany", { count: languages.length });
  }
  return languages.join(" · ");
}

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

        {query.isLoading && models.length === 0 ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowHint}>{t("settings.host.dictation.loading")}</Text>
          </View>
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
    </SettingsSection>
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
  const title = dictationModelTitle(t, model.id, model.description);
  const speedLabel = formatDictationDownloadSpeed(downloadBytesPerSecond);

  let hintText: string;
  if (showProgress) {
    if (percent === null) {
      hintText = t("settings.host.dictation.downloading");
    } else {
      hintText = t("settings.host.dictation.downloadingPercentWithSpeed", {
        percent,
        speed: speedLabel,
      });
    }
  } else {
    hintText = formatLanguages(t, model.languages);
  }

  let trailing: ReactNode = null;
  if (pending) {
    trailing = <ThemedActivityIndicator uniProps={mutedColorMapping} />;
  } else if (showProgress) {
    trailing = null;
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
  } else if (selected) {
    trailing = (
      <View style={styles.trailingSelected}>
        <StatusBadge
          label={dictationRunStateLabel(t, runState)}
          variant={runState === "running" ? "success" : "muted"}
        />
        <View style={styles.appliedBadge} accessibilityRole="text">
          <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />
          <Text style={styles.appliedText}>{t("settings.host.dictation.applied")}</Text>
        </View>
      </View>
    );
  } else {
    trailing = (
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
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.modelRow]}
      accessibilityState={accessibilityState}
      testID={`dictation-model-row-${model.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hintText}</Text>
        {showProgress ? (
          <View style={styles.progressTrack} testID={`dictation-model-progress-${model.id}`}>
            <View style={[styles.progressFill, { width: `${percent ?? 0}%` as `${number}%` }]} />
          </View>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  modelRow: {
    alignItems: "center",
  },
  trailingSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  appliedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  appliedText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  progressTrack: {
    marginTop: theme.spacing[2],
    height: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foreground,
  },
}));
