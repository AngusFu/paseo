import { Check } from "lucide-react-native";
import type { TFunction } from "i18next";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import type { VoiceTtsModelInfo } from "@getpaseo/protocol/messages";
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

const VOICE_TTS_DOWNLOAD_POLL_MS = 500;
const EMPTY_VOICE_TTS_MODELS: VoiceTtsModelInfo[] = [];
const ACCESSIBILITY_STATE_SELECTED = { selected: true } as const;
const ACCESSIBILITY_STATE_UNSELECTED = { selected: false } as const;

const VOICE_TTS_MODEL_TITLE_KEYS = {
  "kokoro-en-v0_19": "settings.host.voiceTts.models.kokoroEn",
  "kokoro-int8-multi-lang-v1_1": "settings.host.voiceTts.models.kokoroMultiLang",
} as const;

type VoiceTtsRunState = "running" | "starting" | "stopped";

function voiceTtsModelTitle(t: TFunction, modelId: string, fallback: string): string {
  const key = VOICE_TTS_MODEL_TITLE_KEYS[modelId as keyof typeof VOICE_TTS_MODEL_TITLE_KEYS];
  if (!key) {
    return fallback;
  }
  return t(key);
}

function formatLanguages(t: TFunction, languages: readonly string[]): string {
  if (languages.length > 8) {
    return t("settings.host.voiceTts.languagesMany", { count: languages.length });
  }
  return languages.join(" · ");
}

function resolveVoiceTtsRunState(selected: boolean, readinessAvailable: boolean): VoiceTtsRunState {
  if (selected && readinessAvailable) return "running";
  if (selected) return "starting";
  return "stopped";
}

function voiceTtsRunStateLabel(t: TFunction, state: VoiceTtsRunState): string {
  if (state === "running") return t("settings.host.voiceTts.running");
  if (state === "starting") return t("settings.host.voiceTts.starting");
  return t("settings.host.voiceTts.stopped");
}

function formatVoiceTtsDownloadSpeed(bytesPerSecond: number): string {
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

function resolveVoiceTtsDownloadProgress(params: {
  model: VoiceTtsModelInfo;
  downloading: boolean;
  optimistic: boolean;
}): number | null {
  if (typeof params.model.downloadProgress === "number") {
    return params.model.downloadProgress;
  }
  if (params.downloading || params.optimistic) {
    return 0;
  }
  return null;
}

function resolveVoiceTtsDownloadSpeed(model: VoiceTtsModelInfo): number {
  if (typeof model.downloadBytesPerSecond === "number") {
    return model.downloadBytesPerSecond;
  }
  return 0;
}

function isVoiceTtsModelDownloading(params: {
  model: VoiceTtsModelInfo;
  optimistic: boolean;
}): boolean {
  if (params.optimistic) {
    return true;
  }
  return params.model.downloading === true;
}

function useVoiceTtsModels(
  serverId: string,
  options: {
    forcePoll: boolean;
  },
) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.voiceTtsModelSelection === true,
  );
  const queryKey = ["voice-tts-models", serverId] as const;
  const forcePoll = options.forcePoll;
  const query = useFetchQuery({
    queryKey,
    enabled: Boolean(client && isConnected && supported),
    dataShape: "list",
    staleTimeMs: forcePoll ? 0 : 5_000,
    refetchInterval: (queryState) => {
      if (forcePoll) {
        return VOICE_TTS_DOWNLOAD_POLL_MS;
      }
      const data = queryState.state.data;
      if (!data) {
        return false;
      }
      if (data.readiness?.downloading === true) {
        return VOICE_TTS_DOWNLOAD_POLL_MS;
      }
      if (
        data.models.some(
          (model) => model.downloading === true || typeof model.downloadProgress === "number",
        )
      ) {
        return VOICE_TTS_DOWNLOAD_POLL_MS;
      }
      if (
        data.models.some((model) => model.id === data.current.model && model.installed !== true)
      ) {
        return VOICE_TTS_DOWNLOAD_POLL_MS;
      }
      return false;
    },
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return client.listVoiceTtsModels();
    },
  });
  return { query, queryKey, supported, client, isConnected };
}

export function VoiceTtsModelCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [trackingModelIds, setTrackingModelIds] = useState<Set<string>>(() => new Set());
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const forcePoll = trackingModelIds.size > 0 || pendingModel !== null;
  const { query, queryKey, supported, client, isConnected } = useVoiceTtsModels(serverId, {
    forcePoll,
  });

  const models = query.data?.models ?? EMPTY_VOICE_TTS_MODELS;
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
          await client.setVoiceTtsModel(modelId);
          await queryClient.invalidateQueries({ queryKey });
        } catch (error) {
          setTrackingModelIds((prev) => {
            const next = new Set(prev);
            next.delete(modelId);
            return next;
          });
          Alert.alert(
            t("settings.host.voiceTts.selectErrorTitle"),
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
        title={t("settings.host.voiceTts.title")}
        testID="host-page-voice-tts-model-card"
      >
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowHint}>{t("settings.host.voiceTts.unsupported")}</Text>
            </View>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t("settings.host.voiceTts.title")}
      testID="host-page-voice-tts-model-card"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowHint}>{t("settings.host.voiceTts.hint")}</Text>
            {usingNonLocalProvider ? (
              <Text style={settingsStyles.rowHint} testID="host-page-voice-tts-cloud-provider-hint">
                {t("settings.host.voiceTts.cloudProviderHint", { provider: currentProvider })}
              </Text>
            ) : null}
            {query.isError ? (
              <Text style={settingsStyles.rowError} testID="host-page-voice-tts-load-error">
                {query.error instanceof Error
                  ? query.error.message
                  : t("settings.host.voiceTts.loadError")}
              </Text>
            ) : null}
          </View>
        </View>

        {query.isLoading && models.length === 0 ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowHint}>{t("settings.host.voiceTts.loading")}</Text>
          </View>
        ) : (
          models.map((model) => {
            const selected = model.id === currentModel && !usingNonLocalProvider;
            const optimistic = trackingModelIds.has(model.id) && model.installed !== true;
            const downloading = isVoiceTtsModelDownloading({ model, optimistic });
            const progress = resolveVoiceTtsDownloadProgress({ model, downloading, optimistic });
            const speed = resolveVoiceTtsDownloadSpeed(model);

            return (
              <VoiceTtsModelRow
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

function VoiceTtsModelRow({
  model,
  selected,
  pending,
  downloading,
  downloadProgress,
  downloadBytesPerSecond,
  readinessAvailable,
  onApply,
}: {
  model: VoiceTtsModelInfo;
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
  const runState = resolveVoiceTtsRunState(selected, readinessAvailable);
  const title = voiceTtsModelTitle(t, model.id, model.description);
  const speedLabel = formatVoiceTtsDownloadSpeed(downloadBytesPerSecond);

  let hintText: string;
  if (showProgress) {
    if (percent === null) {
      hintText = t("settings.host.voiceTts.downloading");
    } else {
      hintText = t("settings.host.voiceTts.downloadingPercentWithSpeed", {
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
        accessibilityLabel={t("settings.host.voiceTts.download")}
        testID={`voice-tts-model-download-${model.id}`}
      >
        {t("settings.host.voiceTts.download")}
      </Button>
    );
  } else if (selected) {
    trailing = (
      <View style={styles.trailingSelected}>
        <StatusBadge
          label={voiceTtsRunStateLabel(t, runState)}
          variant={runState === "running" ? "success" : "muted"}
        />
        <View style={styles.appliedBadge} accessibilityRole="text">
          <ThemedCheck size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />
          <Text style={styles.appliedText}>{t("settings.host.voiceTts.applied")}</Text>
        </View>
      </View>
    );
  } else {
    trailing = (
      <Button
        size="sm"
        variant="secondary"
        onPress={handleApply}
        accessibilityLabel={t("settings.host.voiceTts.apply")}
        testID={`voice-tts-model-apply-${model.id}`}
      >
        {t("settings.host.voiceTts.apply")}
      </Button>
    );
  }

  return (
    <View
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.modelRow]}
      accessibilityState={accessibilityState}
      testID={`voice-tts-model-row-${model.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hintText}</Text>
        {showProgress ? (
          <View style={styles.progressTrack} testID={`voice-tts-model-progress-${model.id}`}>
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
