import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronRight, Plug } from "lucide-react-native";
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
import { useFrozenWhileHidden } from "@/hooks/use-frozen-while-hidden";
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
  email: string;
  clientId: string;
  secret: string;
  token: string;
}

// Only send secret material the user actually typed, so a blank field never
// wipes a stored token/secret. Email is Jira-only (Jira Cloud Basic auth =
// email + token); GitLab never sends it.
function buildCreateInput(v: ConnectionFormValues): CreateKanbanConnectionInput {
  return {
    kind: v.kind,
    name: v.name,
    baseUrl: v.baseUrl,
    ...(v.kind === "jira" && v.email ? { email: v.email } : {}),
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
    email: v.kind === "jira" ? v.email || null : null,
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

// Jira Cloud authenticates with email + token (Basic auth); GitLab uses just a
// token. So the email field only appears for Jira.
function ConnectionEmailField({
  kind,
  email,
  onChange,
  size,
}: {
  kind: KanbanSourceKind;
  email: string;
  onChange: (value: string) => void;
  size: FieldControlSize;
}): ReactElement | null {
  const { t } = useTranslation();
  if (kind !== "jira") {
    return null;
  }
  return (
    <Field
      label={t("kanban.connectionForm.emailLabel")}
      hint={t("kanban.connectionForm.emailHint")}
    >
      <FormTextInput
        size={size}
        testID="kanban-connection-email-input"
        accessibilityLabel={t("kanban.connectionForm.emailLabel")}
        initialValue={email}
        value={email}
        onChangeText={onChange}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />
    </Field>
  );
}

// Collapsible "Advanced: OAuth (optional)" disclosure — OAuth is the heavy path,
// so it's hidden by default behind the primary paste-a-token flow. Collapsing
// only hides the inputs; their values live in the parent's state and survive.
function OAuthAdvancedSection({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  return (
    <View style={styles.advanced}>
      <Pressable
        style={styles.advancedHeader}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={open ? EXPANDED_STATE : COLLAPSED_STATE}
        testID="kanban-connection-oauth-toggle"
      >
        {open ? (
          <ChevronDown size={16} color={styles.advancedIcon.color} />
        ) : (
          <ChevronRight size={16} color={styles.advancedIcon.color} />
        )}
        <Text style={styles.advancedTitle}>{t("kanban.connectionForm.oauthAdvanced")}</Text>
      </Pressable>
      {open ? <View style={styles.advancedBody}>{children}</View> : null}
    </View>
  );
}

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

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
  const [email, setEmail] = useState(connection?.email ?? "");
  const [oauthClientId, setOauthClientId] = useState(connection?.oauthClientId ?? "");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = name.trim().length > 0 && baseUrl.trim().length > 0 && !isSubmitting;

  const connectionStatusLabel = useMemo(() => {
    if (!connection) {
      return "";
    }
    return connection.authConnected
      ? t("kanban.connections.connected")
      : t("kanban.connections.notConnected");
  }, [connection, t]);

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
        email: email.trim(),
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
    email,
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

  // Freeze the edit/create decision while the sheet fades out — the parent nulls
  // the form on close but the web sheet stays mounted for its exit animation, so
  // recomputing would flash the footer to the create-mode layout.
  const isEdit = useFrozenWhileHidden(visible, mode === "edit" && connection !== undefined);

  const footer = useMemo(() => {
    // Jira-style: destructive Delete on the far left, a spring, then the
    // Cancel/Save pair on the right. Create mode has no Delete and the two
    // buttons split the row.
    return (
      <View style={styles.footer}>
        {isEdit ? (
          <Button
            size={controlSize}
            variant="destructive"
            onPress={handleDelete}
            disabled={isSubmitting}
            testID="kanban-connection-delete"
          >
            {t("kanban.connections.delete")}
          </Button>
        ) : null}
        {isEdit ? <View style={styles.footerSpring} /> : null}
        <Button
          size={controlSize}
          style={isEdit ? undefined : styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          size={controlSize}
          style={isEdit ? undefined : styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="kanban-connection-submit"
        >
          {isEdit ? t("kanban.connectionForm.save") : t("kanban.connectionForm.create")}
        </Button>
      </View>
    );
  }, [canSubmit, controlSize, handleDelete, handleSubmitPress, isEdit, isSubmitting, onClose, t]);

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
          placeholder={t(
            kind === "gitlab"
              ? "kanban.connectionForm.baseUrlPlaceholderGitlab"
              : "kanban.connectionForm.baseUrlPlaceholderJira",
          )}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>

      <ConnectionEmailField kind={kind} email={email} onChange={setEmail} size={controlSize} />

      <Field
        label={t("kanban.connectionForm.tokenLabel")}
        hint={t(
          kind === "gitlab"
            ? "kanban.connectionForm.tokenHintGitlab"
            : "kanban.connectionForm.tokenHintJira",
        )}
      >
        <FormTextInput
          size={controlSize}
          testID="kanban-connection-token-input"
          accessibilityLabel={t("kanban.connectionForm.tokenLabel")}
          initialValue={token}
          value={token}
          onChangeText={setToken}
          placeholder={t("kanban.connectionForm.tokenPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </Field>

      <OAuthAdvancedSection>
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

        {connection ? (
          <>
            <Text style={styles.statusLine}>{connectionStatusLabel}</Text>
            <Button
              variant="outline"
              leftIcon={Plug}
              onPress={handleConnect}
              loading={mutations.isConnecting}
              testID="kanban-connection-connect"
            >
              {connection.kind === "gitlab"
                ? t("kanban.connections.connectGitlab")
                : t("kanban.connections.connectJira")}
            </Button>
          </>
        ) : (
          <Text style={styles.connectHint}>{t("kanban.connectionForm.connectHint")}</Text>
        )}
      </OAuthAdvancedSection>

      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  // Pushes the Cancel/Save pair to the right of the destructive Delete.
  footerSpring: {
    flex: 1,
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
  advanced: {
    gap: theme.spacing[3],
  },
  advancedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  advancedIcon: {
    color: theme.colors.foregroundMuted,
  },
  advancedTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  advancedBody: {
    gap: theme.spacing[3],
  },
  statusLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
