import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { McpCliRuntimeStatus, McpCliServerConfig } from "@getpaseo/protocol/mcp-cli/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { parseMcpServersJson, serializeMcpServersJson } from "@/screens/settings/mcp-servers-json";
import { formatMcpCliToolListSummary } from "@/screens/settings/mcp-cli-test-summary";
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

function isStdioServer(server: McpCliServerConfig): boolean {
  return server.transport === "stdio" || Boolean(server.command && !server.url);
}

function formatStdioSummary(server: McpCliServerConfig): string {
  const parts = [server.command ?? "", ...(server.args ?? [])].filter(Boolean);
  return parts.join(" ") || "stdio";
}

function parseArgsLine(value: string): string[] | undefined {
  const args = value
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  return args.length > 0 ? args : undefined;
}

function buildServerCardConfig(input: {
  server: McpCliServerConfig;
  enabled: boolean;
  stdio: boolean;
  url: string;
  command: string;
  argsLine: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): McpCliServerConfig {
  const { server, enabled, stdio, url, command, argsLine, clientId, clientSecret, redirectUri } =
    input;
  if (stdio) {
    const next: McpCliServerConfig = {
      name: server.name,
      transport: "stdio",
      command: command.trim() || server.command || "",
      enabled,
    };
    const args = parseArgsLine(argsLine);
    if (args) next.args = args;
    if (server.env) next.env = server.env;
    if (server.cwd) next.cwd = server.cwd;
    if (server.preset) next.preset = true;
    return next;
  }
  const oauth = buildOauthAuth(clientId, clientSecret, redirectUri);
  // OAuth form empty: keep imported bearer / DCR oauth (no clientId). Clearing
  // Client ID still drops pre-registered oauth (buildOauthAuth returns undefined
  // and those rows have clientId, so they are not preserved here).
  const preservedAuth =
    server.auth?.kind === "bearer" || (server.auth?.kind === "oauth" && !server.auth.clientId)
      ? server.auth
      : undefined;
  const next: McpCliServerConfig = {
    name: server.name,
    transport: "http",
    url: url.trim() || server.url || "",
    enabled,
    auth: oauth ?? preservedAuth,
  };
  if (server.headers && Object.keys(server.headers).length > 0) {
    next.headers = server.headers;
  }
  if (server.preset) {
    next.preset = true;
  }
  return next;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serverCardFieldResetKey(server: McpCliServerConfig, stdio: boolean): string {
  const oauth = server.auth?.kind === "oauth" ? server.auth : null;
  return [
    server.name,
    stdio ? "stdio" : "http",
    server.url ?? "",
    server.command ?? "",
    (server.args ?? []).join(" "),
    server.enabled ? "1" : "0",
    oauth?.clientId ?? "",
    oauth?.clientSecret ?? "",
    oauth?.redirectUri ?? "",
  ].join("|");
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
  const stdio = isStdioServer(server);
  const initial = oauthFromServer(server);
  const [enabled, setEnabled] = useState(server.enabled);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState(initial.clientSecret);
  const [redirectUri, setRedirectUri] = useState(initial.redirectUri);
  const [url, setUrl] = useState(server.url ?? "");
  const [command, setCommand] = useState(server.command ?? "");
  const [argsLine, setArgsLine] = useState((server.args ?? []).join(" "));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    const next = oauthFromServer(server);
    setEnabled(server.enabled);
    setUrl(server.url ?? "");
    setCommand(server.command ?? "");
    setArgsLine((server.args ?? []).join(" "));
    setClientId(next.clientId);
    setClientSecret(next.clientSecret);
    setRedirectUri(next.redirectUri);
    setTestResult(null);
  }, [server]);

  const buildConfig = useCallback(
    (nextEnabled: boolean): McpCliServerConfig =>
      buildServerCardConfig({
        server,
        enabled: nextEnabled,
        stdio,
        url,
        command,
        argsLine,
        clientId,
        clientSecret,
        redirectUri,
      }),
    [argsLine, clientId, clientSecret, command, redirectUri, server, stdio, url],
  );

  const persist = useCallback(
    async (next: McpCliServerConfig) => {
      setSaving(true);
      try {
        await onSave(next);
        toast.show(t("settings.hostSections.fastmcp.savedToast"), { variant: "success" });
      } catch (err) {
        toast.error(errorMessage(err));
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
          toast.show(result.message, { variant: "success" });
          return;
        }
        toast.error(result.message);
      } catch (err) {
        const message = errorMessage(err);
        setTestResult({ ok: false, message });
        toast.error(message);
      } finally {
        setTesting(false);
      }
    })();
  }, [onTest, server.name, toast]);

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
        toast.error(errorMessage(err));
      }
    })();
  }, [onDelete, server.name, t, toast]);

  const summary = stdio ? formatStdioSummary(server) : (server.url ?? "");

  return (
    <View
      style={[settingsStyles.card, styles.serverCard]}
      testID={`host-fastmcp-server-${server.name}`}
    >
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{server.name}</Text>
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {summary}
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
        isStdio={stdio}
        busy={busy}
        saving={saving}
        testing={testing}
        enabled={enabled}
        fieldResetKey={serverCardFieldResetKey(server, stdio)}
        url={url}
        command={command}
        argsLine={argsLine}
        clientId={clientId}
        clientSecret={clientSecret}
        redirectUri={redirectUri}
        testResultText={testResult?.message ?? null}
        testOk={testResult?.ok ?? false}
        onUrlChange={setUrl}
        onCommandChange={setCommand}
        onArgsLineChange={setArgsLine}
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
  isStdio,
  busy,
  saving,
  testing,
  enabled,
  fieldResetKey,
  url,
  command,
  argsLine,
  clientId,
  clientSecret,
  redirectUri,
  testResultText,
  testOk,
  onUrlChange,
  onCommandChange,
  onArgsLineChange,
  onClientIdChange,
  onClientSecretChange,
  onRedirectUriChange,
  onSave,
  onTest,
  onDelete,
}: {
  serverName: string;
  isPreset: boolean;
  isStdio: boolean;
  busy: boolean;
  saving: boolean;
  testing: boolean;
  enabled: boolean;
  fieldResetKey: string;
  url: string;
  command: string;
  argsLine: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  testResultText: string | null;
  testOk: boolean;
  onUrlChange: (value: string) => void;
  onCommandChange: (value: string) => void;
  onArgsLineChange: (value: string) => void;
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
      {isStdio ? (
        <>
          <Field
            label={t("settings.hostSections.fastmcp.command")}
            testID={`fastmcp-${serverName}-command`}
          >
            <FormTextInput
              size="sm"
              initialValue={command}
              resetKey={`${fieldResetKey}|command`}
              onChangeText={onCommandChange}
              autoCapitalize="none"
              autoCorrect={false}
              editable={editable}
              placeholder={t("settings.hostSections.fastmcp.commandPlaceholder")}
            />
          </Field>
          <Field
            label={t("settings.hostSections.fastmcp.args")}
            testID={`fastmcp-${serverName}-args`}
          >
            <FormTextInput
              size="sm"
              initialValue={argsLine}
              resetKey={`${fieldResetKey}|args`}
              onChangeText={onArgsLineChange}
              autoCapitalize="none"
              autoCorrect={false}
              editable={editable}
              placeholder={t("settings.hostSections.fastmcp.argsPlaceholder")}
            />
          </Field>
          <Text style={settingsStyles.rowHint}>{t("settings.hostSections.fastmcp.argsHint")}</Text>
        </>
      ) : (
        <>
          <Text style={settingsStyles.rowHint}>
            {t("settings.hostSections.fastmcp.oauthPasteHint")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.hostSections.fastmcp.authOptionalHint")}
          </Text>

          <Field
            label={t("settings.hostSections.fastmcp.url")}
            testID={`fastmcp-${serverName}-url`}
          >
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
        </>
      )}

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
  const [newTransport, setNewTransport] = useState<"http" | "stdio">("http");
  const [newUrl, setNewUrl] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgsLine, setNewArgsLine] = useState("");

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
      return {
        ok: true,
        message: formatMcpCliToolListSummary(payload.stdout, {
          emptyMessage: t("settings.hostSections.fastmcp.testOkMessage"),
        }),
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
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      toast.error(t("settings.hostSections.fastmcp.addNameInvalid"));
      return;
    }
    let next: McpCliServerConfig;
    if (newTransport === "stdio") {
      const command = newCommand.trim();
      if (!name || !command) {
        toast.error(t("settings.hostSections.fastmcp.addValidationStdio"));
        return;
      }
      next = {
        name,
        transport: "stdio",
        command,
        enabled: true,
      };
      const args = parseArgsLine(newArgsLine);
      if (args) next.args = args;
    } else {
      const url = newUrl.trim();
      if (!name || !url) {
        toast.error(t("settings.hostSections.fastmcp.addValidation"));
        return;
      }
      next = { name, transport: "http", url, enabled: true };
    }
    setJsonBusy(true);
    void (async () => {
      try {
        await handleSave(next);
        setAddOpen(false);
        setNewName("");
        setNewUrl("");
        setNewCommand("");
        setNewArgsLine("");
        setNewTransport("http");
        toast.show(t("settings.hostSections.fastmcp.savedToast"), { variant: "success" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setJsonBusy(false);
      }
    })();
  }, [client, handleSave, newArgsLine, newCommand, newName, newTransport, newUrl, t, toast]);

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
        <SegmentedControl
          size="sm"
          value={newTransport}
          onValueChange={setNewTransport}
          testID="host-fastmcp-add-transport"
          options={[
            {
              value: "http",
              label: t("settings.hostSections.fastmcp.transportHttp"),
              testID: "host-fastmcp-add-transport-http",
            },
            {
              value: "stdio",
              label: t("settings.hostSections.fastmcp.transportStdio"),
              testID: "host-fastmcp-add-transport-stdio",
            },
          ]}
        />
        {newTransport === "stdio" ? (
          <>
            <Field label={t("settings.hostSections.fastmcp.command")}>
              <FormTextInput
                size="sm"
                value={newCommand}
                onChangeText={setNewCommand}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t("settings.hostSections.fastmcp.commandPlaceholder")}
                testID="host-fastmcp-add-command"
              />
            </Field>
            <Field label={t("settings.hostSections.fastmcp.args")}>
              <FormTextInput
                size="sm"
                value={newArgsLine}
                onChangeText={setNewArgsLine}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t("settings.hostSections.fastmcp.argsPlaceholder")}
                testID="host-fastmcp-add-args"
              />
            </Field>
            <Text style={settingsStyles.rowHint}>
              {t("settings.hostSections.fastmcp.argsHint")}
            </Text>
          </>
        ) : (
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
        )}
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
