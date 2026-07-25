import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { McpCliRuntimeStatus, McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { parseMcpServersJson, serializeMcpServersJson } from "@/screens/settings/mcp-servers-json";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

const ATLASSIAN_DEFAULT_REDIRECT = "http://localhost:62367/callback";
const EMPTY_MCP_SERVERS_JSON = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;

interface TestResult {
  ok: boolean;
  message: string;
}

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

function defaultRedirectFor(name: string): string {
  return name === "atlassian" ? ATLASSIAN_DEFAULT_REDIRECT : "";
}

function oauthFromServer(server: McpCliServerConfig): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const auth = server.auth?.kind === "oauth" ? server.auth : null;
  return {
    clientId: auth?.clientId ?? "",
    clientSecret: auth?.clientSecret ?? "",
    redirectUri: auth?.redirectUri ?? defaultRedirectFor(server.name),
  };
}

function buildOauthAuth(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): McpCliServerConfig["auth"] {
  const trimmedId = clientId.trim();
  if (!trimmedId) {
    return undefined;
  }
  const auth: NonNullable<McpCliServerConfig["auth"]> = {
    kind: "oauth",
    clientId: trimmedId,
  };
  if (clientSecret.trim()) {
    auth.clientSecret = clientSecret.trim();
  }
  if (redirectUri.trim()) {
    auth.redirectUri = redirectUri.trim();
  }
  return auth;
}

function ServerCard({
  server,
  busy,
  onSave,
  onTest,
  onDelete,
}: {
  server: McpCliServerConfig;
  busy: boolean;
  onSave: (next: McpCliServerConfig) => Promise<void>;
  onTest: (name: string) => Promise<TestResult>;
  onDelete: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const initial = oauthFromServer(server);
  const [enabled, setEnabled] = useState(server.enabled);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState(initial.clientSecret);
  const [redirectUri, setRedirectUri] = useState(initial.redirectUri);
  const [url, setUrl] = useState(server.url);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    const next = oauthFromServer(server);
    setEnabled(server.enabled);
    setUrl(server.url);
    setClientId(next.clientId);
    setClientSecret(next.clientSecret);
    setRedirectUri(next.redirectUri);
    setTestResult(null);
  }, [server]);

  const buildConfig = useCallback(
    (nextEnabled: boolean): McpCliServerConfig => ({
      ...server,
      enabled: nextEnabled,
      url: url.trim() || server.url,
      auth: buildOauthAuth(clientId, clientSecret, redirectUri),
    }),
    [clientId, clientSecret, redirectUri, server, url],
  );

  const persist = useCallback(
    async (next: McpCliServerConfig) => {
      setSaving(true);
      try {
        await onSave(next);
        toast.show(t("settings.hostSections.fastmcp.savedToast"), { variant: "success" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [onSave, t, toast],
  );

  const handleToggle = useCallback(
    (next: boolean) => {
      setEnabled(next);
      void persist(buildConfig(next)).catch(() => {
        setEnabled(!next);
      });
    },
    [buildConfig, persist],
  );

  const handleSavePress = useCallback(() => {
    void persist(buildConfig(enabled));
  }, [buildConfig, enabled, persist]);

  const handleTestPress = useCallback(() => {
    void (async () => {
      setTesting(true);
      setTestResult(null);
      try {
        const result = await onTest(server.name);
        setTestResult(result);
        if (result.ok) {
          toast.show(t("settings.hostSections.fastmcp.testOkTitle"), { variant: "success" });
        } else {
          toast.error(result.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTestResult({ ok: false, message });
        toast.error(message);
      } finally {
        setTesting(false);
      }
    })();
  }, [onTest, server.name, t, toast]);

  const handleDeletePress = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("settings.hostSections.fastmcp.deleteTitle"),
        message: t("settings.hostSections.fastmcp.deleteMessage", { name: server.name }),
        confirmLabel: t("settings.hostSections.fastmcp.delete"),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await onDelete(server.name);
        toast.show(t("settings.hostSections.fastmcp.deletedToast"), { variant: "success" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [onDelete, server.name, t, toast]);

  let testResultText: string | null = null;
  if (testResult) {
    testResultText = testResult.ok
      ? t("settings.hostSections.fastmcp.testOkInline")
      : testResult.message;
  }

  const fieldResetKey = [
    server.name,
    server.url,
    server.enabled ? "1" : "0",
    server.auth?.kind === "oauth" ? server.auth.clientId : "",
    server.auth?.kind === "oauth" ? (server.auth.clientSecret ?? "") : "",
    server.auth?.kind === "oauth" ? (server.auth.redirectUri ?? "") : "",
  ].join("|");

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
          onValueChange={handleToggle}
          disabled={busy || saving}
          accessibilityLabel={t("settings.hostSections.fastmcp.enable", { name: server.name })}
        />
      </View>

      <ServerCardEditor
        serverName={server.name}
        isPreset={Boolean(server.preset)}
        busy={busy}
        saving={saving}
        testing={testing}
        enabled={enabled}
        fieldResetKey={fieldResetKey}
        url={url}
        clientId={clientId}
        clientSecret={clientSecret}
        redirectUri={redirectUri}
        testResultText={testResultText}
        testOk={testResult?.ok ?? false}
        onUrlChange={setUrl}
        onClientIdChange={setClientId}
        onClientSecretChange={setClientSecret}
        onRedirectUriChange={setRedirectUri}
        onSave={handleSavePress}
        onTest={handleTestPress}
        onDelete={handleDeletePress}
      />
    </View>
  );
}

function ServerCardEditor({
  serverName,
  isPreset,
  busy,
  saving,
  testing,
  enabled,
  fieldResetKey,
  url,
  clientId,
  clientSecret,
  redirectUri,
  testResultText,
  testOk,
  onUrlChange,
  onClientIdChange,
  onClientSecretChange,
  onRedirectUriChange,
  onSave,
  onTest,
  onDelete,
}: {
  serverName: string;
  isPreset: boolean;
  busy: boolean;
  saving: boolean;
  testing: boolean;
  enabled: boolean;
  fieldResetKey: string;
  url: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  testResultText: string | null;
  testOk: boolean;
  onUrlChange: (value: string) => void;
  onClientIdChange: (value: string) => void;
  onClientSecretChange: (value: string) => void;
  onRedirectUriChange: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const editable = !busy && !saving;
  const redirectPlaceholder =
    serverName === "atlassian"
      ? ATLASSIAN_DEFAULT_REDIRECT
      : t("settings.hostSections.fastmcp.redirectUriPlaceholder");

  return (
    <View style={styles.serverBody}>
      <Text style={settingsStyles.rowHint}>
        {t("settings.hostSections.fastmcp.oauthPasteHint")}
      </Text>
      <Text style={settingsStyles.rowHint}>
        {t("settings.hostSections.fastmcp.authOptionalHint")}
      </Text>

      <Field label={t("settings.hostSections.fastmcp.url")} testID={`fastmcp-${serverName}-url`}>
        <FormTextInput
          size="sm"
          initialValue={url}
          resetKey={`${fieldResetKey}|url`}
          onChangeText={onUrlChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
        />
      </Field>
      <Field
        label={t("settings.hostSections.fastmcp.clientId")}
        testID={`fastmcp-${serverName}-client-id`}
      >
        <FormTextInput
          size="sm"
          initialValue={clientId}
          resetKey={`${fieldResetKey}|clientId`}
          onChangeText={onClientIdChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
          placeholder={t("settings.hostSections.fastmcp.clientIdPlaceholder")}
        />
      </Field>
      <Field
        label={t("settings.hostSections.fastmcp.clientSecret")}
        testID={`fastmcp-${serverName}-client-secret`}
      >
        <FormTextInput
          size="sm"
          initialValue={clientSecret}
          resetKey={`${fieldResetKey}|clientSecret`}
          onChangeText={onClientSecretChange}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={editable}
          placeholder={t("settings.hostSections.fastmcp.clientSecretPlaceholder")}
        />
      </Field>
      <Field
        label={t("settings.hostSections.fastmcp.redirectUri")}
        testID={`fastmcp-${serverName}-redirect`}
      >
        <FormTextInput
          size="sm"
          initialValue={redirectUri}
          resetKey={`${fieldResetKey}|redirect`}
          onChangeText={onRedirectUriChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
          placeholder={redirectPlaceholder}
        />
      </Field>

      {testResultText ? (
        <Text
          style={testOk ? styles.testOk : styles.errorText}
          testID={`fastmcp-${serverName}-test-result`}
        >
          {testResultText}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          loading={saving}
          disabled={busy || testing}
          onPress={onSave}
          testID={`fastmcp-${serverName}-save`}
        >
          {t("settings.hostSections.fastmcp.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          loading={testing}
          disabled={busy || saving || !enabled}
          onPress={onTest}
          testID={`fastmcp-${serverName}-test`}
        >
          {t("settings.hostSections.fastmcp.test")}
        </Button>
        {!isPreset ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || saving || testing}
            onPress={onDelete}
            testID={`fastmcp-${serverName}-delete`}
          >
            {t("settings.hostSections.fastmcp.delete")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

export function HostFastMcpPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId) ?? null;
  const supported = useHostFeature(serverId, "mcpCli");
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [status, setStatus] = useState<McpCliRuntimeStatus | null>(null);
  const [servers, setServers] = useState<McpCliServerConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [jsonText, setJsonText] = useState(EMPTY_MCP_SERVERS_JSON);
  const [jsonBusy, setJsonBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const jsonHeader = useMemo<SheetHeader>(
    () => ({ title: t("settings.hostSections.fastmcp.jsonTitle") }),
    [t],
  );
  const addHeader = useMemo<SheetHeader>(
    () => ({ title: t("settings.hostSections.fastmcp.addTitle") }),
    [t],
  );

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
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
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
          toast.error(payload.error);
          return;
        }
        setError(null);
        await refresh();
        toast.show(t("settings.hostSections.fastmcp.installOk"), { variant: "success" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast.error(message);
      } finally {
        setBusy(false);
      }
    })();
  }, [client, refresh, t, toast]);

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

  const handleDelete = useCallback(
    async (name: string) => {
      if (!client) return;
      const payload = await client.mcpCliServersDelete(name);
      if (payload.error) {
        throw new Error(payload.error);
      }
      await refresh();
    },
    [client, refresh],
  );

  const handleTest = useCallback(
    async (name: string): Promise<TestResult> => {
      if (!client) {
        return { ok: false, message: "Not connected" };
      }
      const payload = await client.mcpCliServersTest(name);
      if (!payload.ok) {
        return {
          ok: false,
          message:
            payload.error ?? (payload.stderr.trim() || payload.stdout.trim() || "Test failed"),
        };
      }
      const head = payload.stdout.trim().split("\n").slice(0, 3).join(" · ");
      return {
        ok: true,
        message: head || t("settings.hostSections.fastmcp.testOkMessage"),
      };
    },
    [client, t],
  );

  const closeJson = useCallback(() => setJsonOpen(false), []);
  const openJson = useCallback(() => {
    setJsonText(serializeMcpServersJson(servers));
    setJsonOpen(true);
  }, [servers]);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const openAdd = useCallback(() => setAddOpen(true), []);

  const handleImportJson = useCallback(() => {
    if (!client) return;
    const parsed = parseMcpServersJson(jsonText);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setJsonBusy(true);
    void (async () => {
      try {
        for (const server of parsed.servers) {
          const payload = await client.mcpCliServersUpsert(server);
          if (payload.error) {
            throw new Error(payload.error);
          }
        }
        await refresh();
        setJsonOpen(false);
        const warning = parsed.warnings.length > 0 ? ` (${parsed.warnings.length} skipped)` : "";
        toast.show(
          t("settings.hostSections.fastmcp.importOk", {
            count: parsed.servers.length,
          }) + warning,
          { variant: "success" },
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setJsonBusy(false);
      }
    })();
  }, [client, jsonText, refresh, t, toast]);

  const handleAddServer = useCallback(() => {
    if (!client) return;
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) {
      toast.error(t("settings.hostSections.fastmcp.addValidation"));
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      toast.error(t("settings.hostSections.fastmcp.addNameInvalid"));
      return;
    }
    setJsonBusy(true);
    void (async () => {
      try {
        await handleSave({ name, url, enabled: true });
        setAddOpen(false);
        setNewName("");
        setNewUrl("");
        toast.show(t("settings.hostSections.fastmcp.savedToast"), { variant: "success" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setJsonBusy(false);
      }
    })();
  }, [client, handleSave, newName, newUrl, t, toast]);

  const handleImportLocal = useCallback(() => {
    if (!client) return;
    setBusy(true);
    void (async () => {
      try {
        const payload = await client.mcpCliServersImportLocal();
        if (payload.error) {
          toast.error(payload.error);
          return;
        }
        await refresh();
        const warning = payload.warnings.length > 0 ? ` (${payload.warnings.length} skipped)` : "";
        toast.show(
          t("settings.hostSections.fastmcp.importLocalOk", {
            count: payload.servers.length,
          }) + warning,
          { variant: "success" },
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [client, refresh, t, toast]);

  const sectionTrailing = useMemo(
    () => (
      <View style={styles.sectionActions}>
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected || busy}
          loading={busy}
          onPress={handleImportLocal}
          testID="host-fastmcp-import-local"
        >
          {t("settings.hostSections.fastmcp.importLocal")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected || busy}
          onPress={openAdd}
          testID="host-fastmcp-add"
        >
          {t("settings.hostSections.fastmcp.add")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected || busy}
          onPress={openJson}
          testID="host-fastmcp-json"
        >
          {t("settings.hostSections.fastmcp.jsonEdit")}
        </Button>
      </View>
    ),
    [busy, connected, handleImportLocal, openAdd, openJson, t],
  );

  const jsonFooter = useMemo(
    () => (
      <View style={styles.sheetFooter}>
        <Button
          variant="secondary"
          onPress={closeJson}
          disabled={jsonBusy}
          style={styles.footerButton}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={handleImportJson}
          loading={jsonBusy}
          disabled={jsonBusy}
          style={styles.footerButton}
          testID="host-fastmcp-json-import"
        >
          {t("settings.hostSections.fastmcp.import")}
        </Button>
      </View>
    ),
    [closeJson, handleImportJson, jsonBusy, t],
  );

  const addFooter = useMemo(
    () => (
      <View style={styles.sheetFooter}>
        <Button
          variant="secondary"
          onPress={closeAdd}
          disabled={jsonBusy}
          style={styles.footerButton}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={handleAddServer}
          loading={jsonBusy}
          disabled={jsonBusy}
          style={styles.footerButton}
          testID="host-fastmcp-add-submit"
        >
          {t("settings.hostSections.fastmcp.addSubmit")}
        </Button>
      </View>
    ),
    [closeAdd, handleAddServer, jsonBusy, t],
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
        trailing={sectionTrailing}
      >
        {servers.map((server) => (
          <ServerCard
            key={server.name}
            server={server}
            busy={busy}
            onSave={handleSave}
            onTest={handleTest}
            onDelete={handleDelete}
          />
        ))}
      </SettingsSection>

      <AdaptiveModalSheet
        visible={jsonOpen}
        onClose={closeJson}
        header={jsonHeader}
        testID="host-fastmcp-json-sheet"
        footer={jsonFooter}
      >
        <Text style={settingsStyles.rowHint}>{t("settings.hostSections.fastmcp.jsonHint")}</Text>
        <SettingsTextArea
          accessibilityLabel={t("settings.hostSections.fastmcp.jsonTitle")}
          value={jsonText}
          onChangeText={setJsonText}
          placeholder={EMPTY_MCP_SERVERS_JSON}
          testID="host-fastmcp-json-input"
          style={styles.jsonInput}
        />
      </AdaptiveModalSheet>

      <AdaptiveModalSheet
        visible={addOpen}
        onClose={closeAdd}
        header={addHeader}
        testID="host-fastmcp-add-sheet"
        footer={addFooter}
      >
        <Field label={t("settings.hostSections.fastmcp.name")}>
          <FormTextInput
            size="sm"
            value={newName}
            onChangeText={setNewName}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="my-remote"
            testID="host-fastmcp-add-name"
          />
        </Field>
        <Field label={t("settings.hostSections.fastmcp.url")}>
          <FormTextInput
            size="sm"
            value={newUrl}
            onChangeText={setNewUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://…"
            testID="host-fastmcp-add-url"
          />
        </Field>
        <Text style={settingsStyles.rowHint}>{t("settings.hostSections.fastmcp.addHint")}</Text>
      </AdaptiveModalSheet>
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
  sectionActions: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  testOk: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  sheetFooter: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
  jsonInput: {
    minHeight: 220,
    marginTop: theme.spacing[3],
    fontFamily: theme.fontFamily.mono,
  },
}));
