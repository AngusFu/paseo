import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildDaemonHttpOriginUrl } from "@/utils/daemon-endpoints";
import { openExternalUrl } from "@/utils/open-external-url";
import type { Theme } from "@/styles/theme";

interface WorkspaceOpenWebUiButtonProps {
  serverId: string;
}

const ThemedGlobe = withUnistyles(Globe);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function WorkspaceOpenWebUiButton({
  serverId,
}: WorkspaceOpenWebUiButtonProps): ReactElement | null {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const snapshot = useHostRuntimeSnapshot(serverId);
  const hosts = useHosts();
  const webUiEnabled = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.webUi === true,
  );

  const webUiUrl = useMemo(() => {
    const activeConnection = snapshot?.activeConnection;
    if (!activeConnection || activeConnection.type !== "directTcp") {
      return null;
    }

    const host = hosts.find((entry) => entry.serverId === serverId) ?? null;
    const activeConnectionId = snapshot?.activeConnectionId;
    const connection =
      activeConnectionId !== null
        ? (host?.connections.find((entry) => entry.id === activeConnectionId) ?? null)
        : null;
    const useTls = connection?.type === "directTcp" ? connection.useTls === true : false;

    return buildDaemonHttpOriginUrl(activeConnection.endpoint, { useTls });
  }, [hosts, serverId, snapshot?.activeConnection, snapshot?.activeConnectionId]);

  const handlePress = useCallback(() => {
    if (!webUiUrl) {
      return;
    }
    void openExternalUrl(webUiUrl);
  }, [webUiUrl]);

  if (!isConnected || !webUiEnabled || !webUiUrl) {
    return null;
  }

  return (
    <HeaderToggleButton
      testID="workspace-open-web-ui"
      onPress={handlePress}
      tooltipLabel={t("workspace.header.actions.openWebUi")}
      tooltipKeys={[]}
      tooltipSide="bottom"
      style={styles.compactHeaderActionButton}
      accessible
      accessibilityRole="button"
      accessibilityLabel={t("workspace.header.actions.openWebUi")}
    >
      {({ hovered, pressed }) => {
        const colorMapping = hovered || pressed ? foregroundColorMapping : mutedColorMapping;
        return <ThemedGlobe size={16} uniProps={colorMapping} />;
      }}
    </HeaderToggleButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactHeaderActionButton: {
    width: theme.spacing[8],
    height: theme.spacing[8],
    padding: 0,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
}));
