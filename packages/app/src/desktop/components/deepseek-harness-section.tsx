import { useCallback, useEffect, useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useFocusEffect } from "@react-navigation/native";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useDeepseekHarness } from "@/desktop/deepseek-harness";
import type { DesktopDeepseekHarnessStatus } from "@/desktop/host";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

function statusBadgeVariant(
  status: DesktopDeepseekHarnessStatus | null,
  isInstalling: boolean,
  isStarting: boolean,
): "success" | "error" | "muted" {
  if (isInstalling || isStarting) return "muted";
  if (!status) return "muted";
  if (status.running) return "success";
  if (status.lastError) return "error";
  if (status.installed) return "muted";
  return "error";
}

function resolveStatusLabel(
  t: ReturnType<typeof useTranslation>["t"],
  status: DesktopDeepseekHarnessStatus | null,
  isInstalling: boolean,
  isStarting: boolean,
): string {
  if (isInstalling) {
    return t("settings.deepseekHarness.status.installing");
  }
  if (isStarting) {
    return t("settings.deepseekHarness.status.starting");
  }
  if (status?.running) {
    return t("settings.deepseekHarness.status.running");
  }
  if (status?.lastError) {
    return t("settings.deepseekHarness.status.failed");
  }
  if (status?.installed) {
    return t("settings.deepseekHarness.status.stopped");
  }
  return t("settings.deepseekHarness.status.notInstalled");
}

function resolveInstallLabel(
  t: ReturnType<typeof useTranslation>["t"],
  installed: boolean,
  isInstalling: boolean,
): string {
  if (isInstalling) {
    if (installed) {
      return t("settings.deepseekHarness.actions.upgrading");
    }
    return t("settings.deepseekHarness.actions.installing");
  }
  if (installed) {
    return t("settings.deepseekHarness.actions.upgrade");
  }
  return t("settings.deepseekHarness.actions.install");
}

function resolveRuntimeDetail(
  t: ReturnType<typeof useTranslation>["t"],
  status: DesktopDeepseekHarnessStatus | null,
): string | null {
  if (status?.url) {
    return status.url;
  }
  if (status?.port) {
    return t("settings.deepseekHarness.port", { port: status.port });
  }
  return null;
}

interface RuntimeCardProps {
  status: DesktopDeepseekHarnessStatus | null;
  isBusy: boolean;
  isInstalling: boolean;
  isStarting: boolean;
  isStopping: boolean;
  installLog: string;
  onInstall: () => void;
  onStart: () => void;
  onStop: () => void;
}

function DeepseekHarnessRuntimeCard({
  status,
  isBusy,
  isInstalling,
  isStarting,
  isStopping,
  installLog,
  onInstall,
  onStart,
  onStop,
}: RuntimeCardProps) {
  const { t } = useTranslation();
  const logScrollRef = useRef<ScrollView>(null);
  const showInstallLog = isInstalling || installLog.length > 0;
  const showLastError = Boolean(status?.lastError) && !isStarting;
  const runtimeDetail = resolveRuntimeDetail(t, status);
  const installed = Boolean(status?.installed);

  useEffect(() => {
    if (!installLog) return;
    logScrollRef.current?.scrollToEnd({ animated: false });
  }, [installLog]);

  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.deepseekHarness.statusLabel")}</Text>
          <Text style={settingsStyles.rowHint}>
            {status?.version
              ? t("settings.deepseekHarness.version", { version: status.version })
              : t("settings.deepseekHarness.packageHint")}
          </Text>
          {runtimeDetail ? <Text style={settingsStyles.rowHint}>{runtimeDetail}</Text> : null}
        </View>
        <StatusBadge
          variant={statusBadgeVariant(status, isInstalling, isStarting)}
          label={resolveStatusLabel(t, status, isInstalling, isStarting)}
        />
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.actionsRow]}>
        <Button
          size="sm"
          variant="secondary"
          loading={isInstalling}
          disabled={isBusy}
          onPress={onInstall}
          testID="settings-deepseek-harness-install"
        >
          {resolveInstallLabel(t, installed, isInstalling)}
        </Button>
        {status?.running ? (
          <Button
            size="sm"
            variant="secondary"
            loading={isStopping}
            disabled={isBusy}
            onPress={onStop}
            testID="settings-deepseek-harness-stop"
          >
            {t("settings.deepseekHarness.actions.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            loading={isStarting}
            disabled={isBusy || !installed}
            onPress={onStart}
            testID="settings-deepseek-harness-start"
          >
            {t("settings.deepseekHarness.actions.start")}
          </Button>
        )}
      </View>

      {showLastError ? (
        <View
          style={[styles.logPanel, settingsStyles.rowBorder]}
          testID="settings-deepseek-harness-last-error"
        >
          <Text style={styles.logTitle}>{t("settings.deepseekHarness.lastErrorTitle")}</Text>
          <ScrollView
            style={styles.logScroll}
            contentContainerStyle={styles.logScrollContent}
            nestedScrollEnabled
          >
            <Text style={styles.logText} selectable>
              {status?.lastError}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      {showInstallLog ? (
        <View
          style={[styles.logPanel, settingsStyles.rowBorder]}
          testID="settings-deepseek-harness-install-log"
        >
          <Text style={styles.logTitle}>{t("settings.deepseekHarness.installLogTitle")}</Text>
          <ScrollView
            ref={logScrollRef}
            style={styles.logScroll}
            contentContainerStyle={styles.logScrollContent}
            nestedScrollEnabled
          >
            <Text style={styles.logText} selectable>
              {installLog.trim().length > 0
                ? installLog
                : t("settings.deepseekHarness.installLogWaiting")}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

export function DeepseekHarnessSection() {
  const { t } = useTranslation();
  const {
    isAvailable,
    status,
    isBusy,
    isInstalling,
    isStarting,
    isStopping,
    installLog,
    startWithDesktop,
    refresh,
    install,
    start,
    stop,
    setStartWithDesktop,
  } = useDeepseekHarness();

  useFocusEffect(
    useCallback(() => {
      if (!isAvailable) return undefined;
      void refresh();
      return undefined;
    }, [isAvailable, refresh]),
  );

  const handleInstall = useCallback(() => {
    void install();
  }, [install]);

  const handleStart = useCallback(() => {
    void start();
  }, [start]);

  const handleStop = useCallback(() => {
    void stop();
  }, [stop]);

  const handleStartWithDesktopChange = useCallback(
    (value: boolean) => {
      void setStartWithDesktop(value);
    },
    [setStartWithDesktop],
  );

  if (!isAvailable) {
    return (
      <SettingsSection title={t("settings.deepseekHarness.title")}>
        <Text style={settingsStyles.rowHint}>{t("settings.deepseekHarness.unavailable")}</Text>
      </SettingsSection>
    );
  }

  return (
    <View style={styles.container} testID="settings-deepseek-harness">
      <SettingsSection title={t("settings.deepseekHarness.runtimeTitle")}>
        <DeepseekHarnessRuntimeCard
          status={status}
          isBusy={isBusy}
          isInstalling={isInstalling}
          isStarting={isStarting}
          isStopping={isStopping}
          installLog={installLog}
          onInstall={handleInstall}
          onStart={handleStart}
          onStop={handleStop}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.deepseekHarness.launchTitle")} flush>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.deepseekHarness.startWithDesktop")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.deepseekHarness.startWithDesktopDescription")}
              </Text>
            </View>
            <Switch
              value={startWithDesktop}
              disabled={isBusy}
              onValueChange={handleStartWithDesktopChange}
              testID="settings-deepseek-harness-start-with-desktop"
            />
          </View>
        </View>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  actionsRow: {
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  logPanel: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  logTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  logScroll: {
    maxHeight: 180,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  logScrollContent: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  logText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: 18,
  },
}));
