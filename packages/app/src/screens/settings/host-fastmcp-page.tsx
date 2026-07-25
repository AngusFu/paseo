import { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { McpCliRuntimeStatus, McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

const ATLASSIAN_DEFAULT_REDIRECT = "http://localhost:62367/callback";

function runtimeBadgeVariant(status: McpCliRuntimeStatus | null): "success" | "error" | "muted" {
  if (!status) return "muted";
  if (!status.platformSupported) return "muted";
  if (status.ready) return "success";
  if (status.uv.state === "error" || status.venv.state === "error") return "error";
  return "muted";
}

function runtimeStatusLabel(
  status: McpCliRuntimeStatus | null,
  t: (key: string) => string,
): string {
  if (status?.ready) {
    return t("settings.hostSections.fastmcp.ready");
  }
  if (status?.platformSupported === false) {
    return t("settings.hostSections.fastmcp.platformUnsupported");
  }
  return t("settings.hostSections.fastmcp.notReady");
}

function ServerCard({
  server,
  busy,
  onSave,
  onTest,
}: {
  server: McpCliServerConfig;
  busy: boolean;
  onSave: (next: McpCliServerConfig) => Promise<void>;
  onTest: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const auth = server.auth?.kind === "oauth" ? server.auth : null;
  const [enabled, setEnabled] = useState(server.enabled);
  const [clientId, setClientId] = useState(auth?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(auth?.clientSecret ?? "");
  const [redirectUri, setRedirectUri] = useState(
    auth?.redirectUri ?? (server.name === "atlassian" ? ATLASSIAN_DEFAULT_REDIRECT : ""),
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setEnabled(server.enabled);
    const nextAuth = server.auth?.kind === "oauth" ? server.auth : null;
    setClientId(nextAuth?.clientId ?? "");
    setClientSecret(nextAuth?.clientSecret ?? "");
    setRedirectUri(
      nextAuth?.redirectUri ?? (server.name === "atlassian" ? ATLASSIAN_DEFAULT_REDIRECT : ""),
    );
  }, [server]);

  const handleSavePress = useCallback(() => {
    setSaving(true);
    const next: McpCliServerConfig = {
      ...server,
      enabled,
      url: server.url,
      auth: clientId.trim()
        ? {
            kind: "oauth",
            clientId: clientId.trim(),
            ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            ...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
          }
        : undefined,
    };
    void onSave(next)
      .catch((error) => {
        Alert.alert(
          t("settings.hostSections.fastmcp.saveErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => setSaving(false));
  }, [clientId, clientSecret, enabled, onSave, redirectUri, server, t]);

  const handleTestPress = useCallback(() => {
    setTesting(true);
    void onTest(server.name)
      .catch((error) => {
        Alert.alert(
          t("settings.hostSections.fastmcp.testErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => setTesting(false));
  }, [onTest, server.name, t]);

  return (
    <View
      style={[settingsStyles.card, styles.serverCard]}
      testID={`host-fastmcp-server-${server.name}`}
    >
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{server.name}</Text>
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {server.url}
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          disabled={busy || saving}
          accessibilityLabel={t("settings.hostSections.fastmcp.enable", { name: server.name })}
        />
      </View>

      <View style={styles.serverBody}>
        <Text style={settingsStyles.rowHint}>
          {t("settings.hostSections.fastmcp.oauthPasteHint")}
        </Text>

        <Field
          label={t("settings.hostSections.fastmcp.clientId")}
          testID={`fastmcp-${server.name}-client-id`}
        >
          <FormTextInput
            size="sm"
            value={clientId}
            onChangeText={setClientId}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy && !saving}
            placeholder={t("settings.hostSections.fastmcp.clientIdPlaceholder")}
          />
        </Field>
        <Field
          label={t("settings.hostSections.fastmcp.clientSecret")}
          testID={`fastmcp-${server.name}-client-secret`}
        >
          <FormTextInput
            size="sm"
            value={clientSecret}
            onChangeText={setClientSecret}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!busy && !saving}
            placeholder={t("settings.hostSections.fastmcp.clientSecretPlaceholder")}
          />
        </Field>
        <Field
          label={t("settings.hostSections.fastmcp.redirectUri")}
          testID={`fastmcp-${server.name}-redirect`}
        >
          <FormTextInput
            size="sm"
            value={redirectUri}
            onChangeText={setRedirectUri}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy && !saving}
            placeholder={
              server.name === "atlassian"
                ? ATLASSIAN_DEFAULT_REDIRECT
                : t("settings.hostSections.fastmcp.redirectUriPlaceholder")
            }
          />
        </Field>

        <View style={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            loading={saving}
            disabled={busy || testing}
            onPress={handleSavePress}
            testID={`fastmcp-${server.name}-save`}
          >
            {t("settings.hostSections.fastmcp.save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            loading={testing}
            disabled={busy || saving || !enabled}
            onPress={handleTestPress}
            testID={`fastmcp-${server.name}-test`}
          >
            {t("settings.hostSections.fastmcp.test")}
          </Button>
        </View>
      </View>
    </View>
  );
}

export function HostFastMcpPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId) ?? null;
  const supported = useHostFeature(serverId, "mcpCli");
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [status, setStatus] = useState<McpCliRuntimeStatus | null>(null);
  const [servers, setServers] = useState<McpCliServerConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client || !supported) {
      return;
    }
    const [statusPayload, listPayload] = await Promise.all([
      client.mcpCliRuntimeStatus(),
      client.mcpCliServersList(),
    ]);
    if (statusPayload.error) {
      setError(statusPayload.error);
    } else {
      setError(null);
    }
    setStatus(statusPayload.status);
    if (!listPayload.error) {
      setServers(listPayload.servers);
    }
  }, [client, supported]);

  useEffect(() => {
    if (!supported || !client || !connected) {
      return;
    }
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [client, connected, refresh, supported]);

  const handleDetect = useCallback(() => {
    setBusy(true);
    void refresh()
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [refresh]);

  const handleInstall = useCallback(() => {
    if (!client) return;
    setBusy(true);
    void (async () => {
      try {
        const payload = await client.mcpCliRuntimeInstall();
        setStatus(payload.status);
        if (payload.error) {
          setError(payload.error);
          return;
        }
        setError(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [client, refresh]);

  const handleSave = useCallback(
    async (next: McpCliServerConfig) => {
      if (!client) return;
      const payload = await client.mcpCliServersUpsert(next);
      if (payload.error) {
        throw new Error(payload.error);
      }
      await refresh();
    },
    [client, refresh],
  );

  const handleTest = useCallback(
    async (name: string) => {
      if (!client) return;
      const payload = await client.mcpCliServersTest(name);
      if (!payload.ok) {
        throw new Error(
          payload.error ?? (payload.stderr.trim() || payload.stdout.trim() || "Test failed"),
        );
      }
      Alert.alert(
        t("settings.hostSections.fastmcp.testOkTitle"),
        payload.stdout.trim() || t("settings.hostSections.fastmcp.testOkMessage"),
      );
    },
    [client, t],
  );

  if (!host) {
    return (
      <View>
        <View style={settingsStyles.card}>
          <Text style={settingsStyles.rowHint}>{t("settings.host.notFound")}</Text>
        </View>
      </View>
    );
  }

  if (!supported) {
    return (
      <View>
        <SettingsSection title={t("settings.hostSections.fastmcp.title")}>
          <View style={settingsStyles.card}>
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>
                {t("settings.hostSections.fastmcp.unsupported")}
              </Text>
            </View>
          </View>
        </SettingsSection>
      </View>
    );
  }

  return (
    <View>
      <SettingsSection
        title={t("settings.hostSections.fastmcp.runtimeTitle")}
        testID="host-fastmcp-runtime"
      >
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.hostSections.fastmcp.runtimeStatus")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {status?.message ?? t("settings.hostSections.fastmcp.runtimeUnknown")}
              </Text>
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>
            <StatusBadge
              variant={runtimeBadgeVariant(status)}
              label={runtimeStatusLabel(status, t)}
            />
          </View>
          <View style={styles.serverBody}>
            <Text style={settingsStyles.rowHint}>
              {t("settings.hostSections.fastmcp.pathHint")}
            </Text>
            <View style={styles.actions}>
              <Button
                size="sm"
                variant="secondary"
                disabled={!connected || busy}
                loading={busy}
                onPress={handleDetect}
                testID="host-fastmcp-detect"
              >
                {t("settings.hostSections.fastmcp.detect")}
              </Button>
              <Button
                size="sm"
                disabled={!connected || busy || status?.platformSupported === false}
                loading={busy}
                onPress={handleInstall}
                testID="host-fastmcp-install"
              >
                {t("settings.hostSections.fastmcp.install")}
              </Button>
            </View>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("settings.hostSections.fastmcp.serversTitle")}
        testID="host-fastmcp-servers"
      >
        {servers.map((server) => (
          <ServerCard
            key={server.name}
            server={server}
            busy={busy}
            onSave={handleSave}
            onTest={handleTest}
          />
        ))}
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  serverCard: {
    marginBottom: theme.spacing[3],
  },
  serverBody: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
}));
