import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { Plug } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { KanbanSourceKind, StoredKanbanConnection } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import {
  useKanbanConnectionMutations,
  type CreateKanbanConnectionInput,
  type UpdateKanbanConnectionInput,
} from "@/hooks/use-kanban-connection-mutations";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { openExternalUrl } from "@/utils/open-external-url";

export interface KanbanConnectionFormSheetProps {
  serverId: string;
  visible: boolean;
  mode: "create" | "edit";
  connection?: StoredKanbanConnection;
  onClose: () => void;
}

const GITLAB_DEFAULT_BASE_URL = "https://gitlab.com";

interface ConnectionFormValues {
  kind: KanbanSourceKind;
  name: string;
  baseUrl: string;
  clientId: string;
  secret: string;
  token: string;
}

// Only send secret material the user actually typed, so a blank field never
// wipes a stored token/secret.
function buildCreateInput(v: ConnectionFormValues): CreateKanbanConnectionInput {
  return {
    kind: v.kind,
    name: v.name,
    baseUrl: v.baseUrl,
    ...(v.clientId ? { oauthClientId: v.clientId } : {}),
    ...(v.secret ? { oauthClientSecret: v.secret } : {}),
    ...(v.token ? { tokenValue: v.token } : {}),
  };
}

function buildUpdateInput(id: string, v: ConnectionFormValues): UpdateKanbanConnectionInput {
  return {
    id,
    name: v.name,
    baseUrl: v.baseUrl,
    oauthClientId: v.clientId || null,
    ...(v.secret ? { oauthClientSecret: v.secret } : {}),
    ...(v.token ? { tokenValue: v.token } : {}),
  };
}

function ConnectionKindField({
  mode,
  kind,
  onChange,
  options,
  size,
}: {
  mode: "create" | "edit";
  kind: KanbanSourceKind;
  onChange: (kind: KanbanSourceKind) => void;
  options: SegmentedControlOption<KanbanSourceKind>[];
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Field label={t("kanban.connectionForm.kind")}>
      {mode === "create" ? (
        <SegmentedControl
          size={size}
          value={kind}
          onValueChange={onChange}
          options={options}
          testID="kanban-connection-kind"
        />
      ) : (
        <Text style={styles.readonlyKind}>
          {kind === "gitlab" ? t("kanban.connectionForm.gitlab") : t("kanban.connectionForm.jira")}
        </Text>
      )}
    </Field>
  );
}

function ConnectionFooterActions({
  connection,
  isConnecting,
  isSubmitting,
  onConnect,
  onDelete,
}: {
  connection: StoredKanbanConnection | undefined;
  isConnecting: boolean;
  isSubmitting: boolean;
  onConnect: () => void;
  onDelete: () => void;
}): ReactElement {
  const { t } = useTranslation();
  // No id yet on create → the OAuth flow needs a saved connection first.
  if (!connection) {
    return <Text style={styles.connectHint}>{t("kanban.connectionForm.connectHint")}</Text>;
  }
  return (
    <>
      <Button
        variant="outline"
        leftIcon={Plug}
        onPress={onConnect}
        loading={isConnecting}
        testID="kanban-connection-connect"
      >
        {connection.kind === "gitlab"
          ? t("kanban.connections.connectGitlab")
          : t("kanban.connections.connectJira")}
      </Button>
      <Button
        variant="ghost"
        onPress={onDelete}
        disabled={isSubmitting}
        testID="kanban-connection-delete"
      >
        {t("kanban.connections.delete")}
      </Button>
    </>
  );
}

/**
 * Create / edit a Jira or GitLab auth connection: the instance base URL plus
 * credentials (paste token, or OAuth client id/secret), and — in edit mode — a
 * Connect button that starts the OAuth flow and opens the authorize URL.
 */
export function KanbanConnectionFormSheet({
  serverId,
  visible,
  mode,
  connection,
  onClose,
}: KanbanConnectionFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const mutations = useKanbanConnectionMutations({ serverId });

  const [kind, setKind] = useState<KanbanSourceKind>(connection?.kind ?? "jira");
  const [name, setName] = useState(connection?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");

  // GitLab has a well-known SaaS host, so prefill it (still editable for
  // self-hosted). Jira has no default — every instance uses its own domain.
  const handleKindChange = useCallback((nextKind: KanbanSourceKind) => {
    setKind(nextKind);
    setBaseUrl((current) => {
      const trimmed = current.trim();
      if (nextKind === "gitlab" && trimmed === "") {
        return GITLAB_DEFAULT_BASE_URL;
      }
      if (nextKind === "jira" && trimmed === GITLAB_DEFAULT_BASE_URL) {
        return "";
      }
      return current;
    });
  }, []);
  const [oauthClientId, setOauthClientId] = useState(connection?.oauthClientId ?? "");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = name.trim().length > 0 && baseUrl.trim().length > 0 && !isSubmitting;

  const header = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "edit"
          ? t("kanban.connectionForm.editTitle")
          : t("kanban.connectionForm.createTitle"),
    }),
    [mode, t],
  );

  const kindOptions = useMemo<SegmentedControlOption<KanbanSourceKind>[]>(
    () => [
      {
        value: "jira",
        label: t("kanban.connectionForm.jira"),
        testID: "kanban-connection-kind-jira",
      },
      {
        value: "gitlab",
        label: t("kanban.connectionForm.gitlab"),
        testID: "kanban-connection-kind-gitlab",
      },
    ],
    [t],
  );

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const values: ConnectionFormValues = {
        kind,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        clientId: oauthClientId.trim(),
        secret: oauthClientSecret.trim(),
        token: token.trim(),
      };
      if (mode === "edit" && connection) {
        await mutations.updateConnection(buildUpdateInput(connection.id, values));
      } else {
        await mutations.createConnection(buildCreateInput(values));
      }
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    baseUrl,
    canSubmit,
    connection,
    kind,
    mode,
    mutations,
    name,
    oauthClientId,
    oauthClientSecret,
    onClose,
    token,
  ]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const handleConnect = useCallback(() => {
    if (!connection) {
      return;
    }
    void (async () => {
      setSubmitError(null);
      try {
        const authorizeUrl = await mutations.connect(connection.id);
        if (authorizeUrl) {
          void openExternalUrl(authorizeUrl);
        }
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      }
    })();
  }, [connection, mutations]);

  const handleDelete = useCallback(() => {
    if (!connection) {
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("kanban.connections.delete"),
        message: t("kanban.connections.confirmDelete", { name: connection.name }),
        confirmLabel: t("kanban.connections.delete"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        await mutations.deleteConnection(connection.id);
        onClose();
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      }
    })();
  }, [connection, mutations, onClose, t]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="kanban-connection-submit"
        >
          {mode === "edit" ? t("kanban.connectionForm.save") : t("kanban.connectionForm.create")}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, mode, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      webScrollbar
      testID="kanban-connection-form-sheet"
    >
      <ConnectionKindField
        mode={mode}
        kind={kind}
        onChange={handleKindChange}
        options={kindOptions}
        size={controlSize}
      />

      <Field label={t("kanban.connectionForm.name")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-connection-name-input"
          accessibilityLabel={t("kanban.connectionForm.name")}
          initialValue={name}
          value={name}
          onChangeText={setName}
          placeholder={t("kanban.connectionForm.namePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label={t("kanban.connectionForm.baseUrl")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-connection-base-url-input"
          accessibilityLabel={t("kanban.connectionForm.baseUrl")}
          initialValue={baseUrl}
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder={t("kanban.connectionForm.baseUrlPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>

      <Field label={t("kanban.connectionForm.token")} hint={t("kanban.connectionForm.authHint")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-connection-token-input"
          accessibilityLabel={t("kanban.connectionForm.token")}
          initialValue={token}
          value={token}
          onChangeText={setToken}
          placeholder={t("kanban.connectionForm.tokenPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </Field>

      <Field label={t("kanban.connectionForm.oauthClientId")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-connection-oauth-client-id-input"
          accessibilityLabel={t("kanban.connectionForm.oauthClientId")}
          initialValue={oauthClientId}
          value={oauthClientId}
          onChangeText={setOauthClientId}
          placeholder="client-id"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label={t("kanban.connectionForm.oauthClientSecret")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-connection-oauth-client-secret-input"
          accessibilityLabel={t("kanban.connectionForm.oauthClientSecret")}
          initialValue={oauthClientSecret}
          value={oauthClientSecret}
          onChangeText={setOauthClientSecret}
          placeholder="client-secret"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </Field>

      <ConnectionFooterActions
        connection={connection}
        isConnecting={mutations.isConnecting}
        isSubmitting={isSubmitting}
        onConnect={handleConnect}
        onDelete={handleDelete}
      />

      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  readonlyKind: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  connectHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
