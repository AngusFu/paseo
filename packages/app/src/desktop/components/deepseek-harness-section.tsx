import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useFocusEffect } from "@react-navigation/native";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useDeepseekHarness } from "@/desktop/deepseek-harness";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

function statusBadgeVariant(
  status: ReturnType<typeof useDeepseekHarness>["status"],
): "success" | "error" | "muted" {
  if (!status) return "muted";
  if (status.running) return "success";
  if (status.installed) return "muted";
  return "error";
}

export function DeepseekHarnessSection() {
  const { t } = useTranslation();
  const {
    isAvailable,
    status,
    isBusy,
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

  let statusLabel = t("settings.deepseekHarness.status.notInstalled");
  if (status?.running) {
    statusLabel = t("settings.deepseekHarness.status.running");
  } else if (status?.installed) {
    statusLabel = t("settings.deepseekHarness.status.installed");
  }

  let runtimeDetail: string | null = null;
  if (status?.url) {
    runtimeDetail = status.url;
  } else if (status?.port) {
    runtimeDetail = t("settings.deepseekHarness.port", { port: status.port });
  }

  return (
    <View style={styles.container} testID="settings-deepseek-harness">
      <SettingsSection title={t("settings.deepseekHarness.runtimeTitle")}>
        <View style={settingsStyles.row}>
          <View style={styles.rowMain}>
            <Text style={settingsStyles.rowTitle}>{t("settings.deepseekHarness.statusLabel")}</Text>
            <Text style={settingsStyles.rowHint}>
              {status?.version
                ? t("settings.deepseekHarness.version", { version: status.version })
                : t("settings.deepseekHarness.packageHint")}
            </Text>
            {runtimeDetail ? <Text style={settingsStyles.rowHint}>{runtimeDetail}</Text> : null}
          </View>
          <StatusBadge variant={statusBadgeVariant(status)} label={statusLabel} />
        </View>

        <View style={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            disabled={isBusy}
            onPress={handleInstall}
            testID="settings-deepseek-harness-install"
          >
            {status?.installed
              ? t("settings.deepseekHarness.actions.upgrade")
              : t("settings.deepseekHarness.actions.install")}
          </Button>
          {status?.running ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={isBusy}
              onPress={handleStop}
              testID="settings-deepseek-harness-stop"
            >
              {t("settings.deepseekHarness.actions.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={isBusy || !status?.installed}
              onPress={handleStart}
              testID="settings-deepseek-harness-start"
            >
              {t("settings.deepseekHarness.actions.start")}
            </Button>
          )}
        </View>
      </SettingsSection>

      <SettingsSection title={t("settings.deepseekHarness.launchTitle")} flush>
        <View style={settingsStyles.row}>
          <View style={styles.rowMain}>
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
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  rowMain: {
    flex: 1,
    gap: theme.spacing[1],
    paddingRight: theme.spacing[3],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
