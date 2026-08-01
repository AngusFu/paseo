import { useCallback } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { KnowledgeBaseEmbeddingsCard } from "@/screens/settings/knowledge-base-embeddings-card";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { buildKnowledgeBasesRoute } from "@/utils/host-routes";

/**
 * Host settings → Knowledge bases: hub redirect + host Embeddings infra.
 * Full manage UI lives on `/knowledge-bases` (K1b). Not a second manage surface.
 */
export function HostKnowledgeBasesPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();

  const openHub = useCallback(() => {
    router.push(buildKnowledgeBasesRoute(serverId));
  }, [serverId]);

  return (
    <View>
      <SettingsSection
        title={t("settings.hostSections.knowledgeBases.title")}
        testID="host-knowledge-bases"
      >
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowHint}>
                {t("settings.hostSections.knowledgeBases.openHubHint")}
              </Text>
              <View style={styles.actions}>
                <Button size="sm" onPress={openHub} testID="host-kb-open-hub">
                  {t("settings.hostSections.knowledgeBases.openHub")}
                </Button>
              </View>
            </View>
          </View>
        </View>
      </SettingsSection>

      <KnowledgeBaseEmbeddingsCard serverId={serverId} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
