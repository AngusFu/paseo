import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type {
  KanbanSourceKind,
  StoredKanbanConnection,
  StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { useKanbanConnections } from "@/hooks/use-kanban-connections";
import {
  useKanbanSourceMutations,
  type CreateKanbanSourceInput,
  type UpdateKanbanSourceInput,
} from "@/hooks/use-kanban-source-mutations";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

export interface KanbanSourceFormSheetProps {
  serverId: string;
  visible: boolean;
  mode: "create" | "edit";
  source?: StoredKanbanSource;
  onClose: () => void;
}

const DEFAULT_POLL_SECONDS = "300";

// Default (editable) query per kind, matching the intended semantics:
// Jira = issues assigned to me and still open; GitLab = MRs awaiting my review.
// GitLab has no "me" shorthand, so the reviewer username is a placeholder.
const DEFAULT_QUERY: Record<KanbanSourceKind, string> = {
  jira: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
  gitlab: "scope=all&state=opened&reviewer_username=YOUR_USERNAME",
};

function parsePollSeconds(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

interface SourceFormValues {
  kind: KanbanSourceKind;
  name: string;
  query: string;
  poll: number | null;
  connectionId: string | null;
  enabled: boolean;
}

function buildCreateInput(v: SourceFormValues): CreateKanbanSourceInput {
  return {
    kind: v.kind,
    name: v.name,
    query: v.query,
    enabled: v.enabled,
    ...(v.poll !== null ? { pollEverySec: v.poll } : {}),
    ...(v.connectionId ? { connectionId: v.connectionId } : {}),
  };
}

function buildUpdateInput(id: string, v: SourceFormValues): UpdateKanbanSourceInput {
  return {
    id,
    name: v.name,
    query: v.query,
    enabled: v.enabled,
    ...(v.poll !== null ? { pollEverySec: v.poll } : {}),
    connectionId: v.connectionId,
  };
}

function SourceKindField({
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
    <Field label={t("kanban.sourceForm.kind")}>
      {mode === "create" ? (
        <SegmentedControl
          size={size}
          value={kind}
          onValueChange={onChange}
          options={options}
          testID="kanban-source-kind"
        />
      ) : (
        <Text style={styles.readonlyKind}>
          {kind === "gitlab" ? t("kanban.sourceForm.gitlab") : t("kanban.sourceForm.jira")}
        </Text>
      )}
    </Field>
  );
}

function ConnectionChip({
  id,
  label,
  selected,
  onSelect,
}: {
  id: string | null;
  label: string;
  selected: boolean;
  onSelect: (id: string | null) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(id), [id, onSelect]);
  const chipStyle = useMemo(() => [styles.chip, selected && styles.chipSelected], [selected]);
  const textStyle = useMemo(
    () => [styles.chipText, selected && styles.chipTextSelected],
    [selected],
  );
  return (
    <Pressable
      style={chipStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      testID={`kanban-source-connection-${id ?? "none"}`}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

function ConnectionPicker({
  connections,
  value,
  onSelect,
}: {
  connections: StoredKanbanConnection[];
  value: string | null;
  onSelect: (id: string | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Field label={t("kanban.sourceForm.connection")} hint={t("kanban.sourceForm.connectionHint")}>
      <View style={styles.chipRow}>
        <ConnectionChip
          id={null}
          label={t("kanban.sourceForm.connectionNone")}
          selected={value === null}
          onSelect={onSelect}
        />
        {connections.map((connection) => (
          <ConnectionChip
            key={connection.id}
            id={connection.id}
            label={connection.name}
            selected={value === connection.id}
            onSelect={onSelect}
          />
        ))}
      </View>
    </Field>
  );
}

/**
 * Create / edit a Jira or GitLab source: what to pull (query), how often (poll),
 * an optional base-URL override, and which auth connection to use. Credentials
 * and the Connect button live on the connection, not here.
 */
export function KanbanSourceFormSheet({
  serverId,
  visible,
  mode,
  source,
  onClose,
}: KanbanSourceFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const mutations = useKanbanSourceMutations({ serverId });
  const { connections } = useKanbanConnections(serverId);

  const [kind, setKind] = useState<KanbanSourceKind>(source?.kind ?? "jira");
  const [name, setName] = useState(source?.name ?? "");
  const [query, setQuery] = useState(source?.query ?? DEFAULT_QUERY[source?.kind ?? "jira"]);

  // Selecting a kind swaps in that kind's default query, but only when the user
  // hasn't typed their own (empty, or still one of the two defaults).
  const handleKindChange = useCallback((nextKind: KanbanSourceKind) => {
    setKind(nextKind);
    setQuery((current) => {
      const trimmed = current.trim();
      if (trimmed === "" || trimmed === DEFAULT_QUERY.jira || trimmed === DEFAULT_QUERY.gitlab) {
        return DEFAULT_QUERY[nextKind];
      }
      return current;
    });
  }, []);
  const [pollEverySec, setPollEverySec] = useState(
    source ? String(source.pollEverySec) : DEFAULT_POLL_SECONDS,
  );
  const [connectionId, setConnectionId] = useState<string | null>(source?.connectionId ?? null);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = name.trim().length > 0 && query.trim().length > 0 && !isSubmitting;

  const header = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "edit" ? t("kanban.sourceForm.editTitle") : t("kanban.sourceForm.createTitle"),
    }),
    [mode, t],
  );

  const kindOptions = useMemo<SegmentedControlOption<KanbanSourceKind>[]>(
    () => [
      { value: "jira", label: t("kanban.sourceForm.jira"), testID: "kanban-source-kind-jira" },
      {
        value: "gitlab",
        label: t("kanban.sourceForm.gitlab"),
        testID: "kanban-source-kind-gitlab",
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
      const values: SourceFormValues = {
        kind,
        name: name.trim(),
        query: query.trim(),
        poll: parsePollSeconds(pollEverySec),
        connectionId,
        enabled,
      };
      if (mode === "edit" && source) {
        await mutations.updateSource(buildUpdateInput(source.id, values));
      } else {
        await mutations.createSource(buildCreateInput(values));
      }
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    connectionId,
    enabled,
    kind,
    mode,
    mutations,
    name,
    onClose,
    pollEverySec,
    query,
    source,
  ]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const handleDelete = useCallback(() => {
    if (!source) {
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("kanban.sources.delete"),
        message: t("kanban.sources.confirmDelete", { name: source.name }),
        confirmLabel: t("kanban.sources.delete"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        await mutations.deleteSource(source.id);
        onClose();
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      }
    })();
  }, [mutations, onClose, source, t]);

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
          testID="kanban-source-submit"
        >
          {mode === "edit" ? t("kanban.sourceForm.save") : t("kanban.sourceForm.create")}
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
      testID="kanban-source-form-sheet"
    >
      <SourceKindField
        mode={mode}
        kind={kind}
        onChange={handleKindChange}
        options={kindOptions}
        size={controlSize}
      />

      <Field label={t("kanban.sourceForm.name")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-source-name-input"
          accessibilityLabel={t("kanban.sourceForm.name")}
          initialValue={name}
          value={name}
          onChangeText={setName}
          placeholder={t("kanban.sourceForm.namePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label={t("kanban.sourceForm.query")} hint={t("kanban.sourceForm.queryHint")}>
        <FormTextInput
          // Remount on kind change so the swapped-in default query is reflected.
          key={`query-${kind}`}
          size={controlSize}
          testID="kanban-source-query-input"
          accessibilityLabel={t("kanban.sourceForm.query")}
          initialValue={query}
          value={query}
          onChangeText={setQuery}
          placeholder={DEFAULT_QUERY[kind]}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <ConnectionPicker connections={connections} value={connectionId} onSelect={setConnectionId} />

      <Field label={t("kanban.sourceForm.pollEverySec")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-source-poll-input"
          accessibilityLabel={t("kanban.sourceForm.pollEverySec")}
          initialValue={pollEverySec}
          value={pollEverySec}
          onChangeText={setPollEverySec}
          placeholder={DEFAULT_POLL_SECONDS}
          keyboardType="number-pad"
        />
      </Field>

      <Field label={t("kanban.sourceForm.enabled")}>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          accessibilityLabel={t("kanban.sourceForm.enabled")}
          testID="kanban-source-enabled-switch"
        />
      </Field>

      {mode === "edit" && source ? (
        <Button
          variant="ghost"
          onPress={handleDelete}
          disabled={isSubmitting}
          testID="kanban-source-delete"
        >
          {t("kanban.sources.delete")}
        </Button>
      ) : null}

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
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  chip: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
  },
  chipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface3,
  },
  chipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chipTextSelected: {
    color: theme.colors.foreground,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
