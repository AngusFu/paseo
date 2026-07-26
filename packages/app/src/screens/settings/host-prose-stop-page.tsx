import { useCallback } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { ProseStopLocalLlmSection } from "@/screens/settings/local-llm-card";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

export function HostProseStopPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);

  const handleEnabledChange = useCallback(
    (next: boolean) => {
      void patchConfig({ proseStop: { enabled: next } }).catch((error) => {
        console.error("[HostProseStopPage] Failed to update prose-stop", error);
        Alert.alert(
          t("settings.host.proseStop.updateErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig, t],
  );

  const handlePreventionPromptChange = useCallback(
    (next: boolean) => {
      void patchConfig({ proseStop: { preventionPrompt: next } }).catch((error) => {
        console.error("[HostProseStopPage] Failed to update prose-stop prevention prompt", error);
        Alert.alert(
          t("settings.host.proseStop.updateErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig, t],
  );

  if (!isConnected) return null;

  return (
    <SettingsSection
      title={t("settings.hostSections.proseStop.title")}
      testID="host-prose-stop-page"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.host.proseStop.label")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.host.proseStop.hint")}</Text>
          </View>
          <Switch
            value={config?.proseStop?.enabled !== false}
            onValueChange={handleEnabledChange}
            accessibilityLabel={t("settings.host.proseStop.label")}
            testID="host-prose-stop-switch"
          />
        </View>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.proseStop.preventionPromptLabel")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.proseStop.preventionPromptHint")}
            </Text>
          </View>
          <Switch
            value={config?.proseStop?.preventionPrompt !== false}
            onValueChange={handlePreventionPromptChange}
            accessibilityLabel={t("settings.host.proseStop.preventionPromptLabel")}
            testID="host-prose-stop-prevention-prompt-switch"
          />
        </View>
        <ProseStopLocalLlmSection serverId={serverId} />
      </View>
    </SettingsSection>
  );
}
