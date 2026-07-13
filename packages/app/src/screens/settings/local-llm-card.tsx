import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useLocalLlmModel } from "@/hooks/use-local-llm-model";
import { settingsStyles } from "@/styles/settings";

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

// Host-settings card for the daemon's on-device LLM. The model is never
// downloaded automatically — this is the explicit opt-in entry point.
export function LocalLlmCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { supported, model, startDownload } = useLocalLlmModel(serverId);

  if (!supported) return null;

  let trailing: React.ReactNode = null;
  let detail: React.ReactNode = null;
  if (model?.status === "downloading") {
    const percent = model.totalBytes
      ? Math.round((model.receivedBytes / model.totalBytes) * 100)
      : 0;
    detail = (
      <Text style={settingsStyles.rowHint} testID="host-page-local-llm-progress">
        {t("settings.host.localLlm.downloading", {
          percent,
          received: formatGb(model.receivedBytes),
          total: model.totalBytes ? formatGb(model.totalBytes) : "?",
        })}
      </Text>
    );
  } else if (model?.status === "ready") {
    trailing = (
      <Text style={settingsStyles.rowHint} testID="host-page-local-llm-ready">
        {t("settings.host.localLlm.ready")}
      </Text>
    );
  } else if (model?.status === "error") {
    detail = (
      <Text style={settingsStyles.rowError} testID="host-page-local-llm-error">
        {model.message}
      </Text>
    );
    trailing = (
      <Button size="sm" testID="host-page-local-llm-download" onPress={startDownload}>
        {t("settings.host.localLlm.download")}
      </Button>
    );
  } else {
    // absent (or status not fetched yet)
    trailing = (
      <Button
        size="sm"
        disabled={model === null}
        testID="host-page-local-llm-download"
        onPress={startDownload}
      >
        {t("settings.host.localLlm.download")}
      </Button>
    );
  }

  return (
    <View style={settingsStyles.card} testID="host-page-local-llm-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.localLlm.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.localLlm.hint")}</Text>
          {detail}
        </View>
        {trailing}
      </View>
    </View>
  );
}
