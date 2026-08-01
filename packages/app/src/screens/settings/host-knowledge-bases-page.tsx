import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  KnowledgeBase,
  KnowledgeBaseImportSourceKind,
  KnowledgeBaseUsage,
} from "@getpaseo/protocol/knowledge-base/types";
import { Download, MoreHorizontal, Trash2 } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { getIsElectron } from "@/constants/platform";
import { pickDirectory } from "@/desktop/pick-directory";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { isValidKbMountSlug } from "@/knowledge-bases/mount-slug";
import { useKnowledgeBases } from "@/knowledge-bases/use-knowledge-bases";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import type { AggregateLoadState } from "@/schedules/aggregated-schedules";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedDownload = withUnistyles(Download);
const ThemedTrash2 = withUnistyles(Trash2);

const mutedColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: { colors: { foreground: string } }) => ({
  color: theme.colors.foreground,
});
const destructiveColorMapping = (theme: { colors: { destructive: string } }) => ({
  color: theme.colors.destructive,
});

const exportLeading = <ThemedDownload size={16} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash2 size={16} uniProps={destructiveColorMapping} />;

function formatShortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatUsageLine(usage: KnowledgeBaseUsage): string {
  const title = usage.title?.trim() || usage.workspaceId;
  return `• ${title} (${usage.workspaceId})   /paseo-vfs/${usage.mountSlug}`;
}

function stopPressInPropagation(event: GestureResponderEvent) {
  event.stopPropagation();
}

function showDeleteBlockedAlert(
  kb: KnowledgeBase,
  workspaces: KnowledgeBaseUsage[],
  t: (key: string, options?: Record<string, string | number>) => string,
): void {
  const list =
    workspaces.length > 0
      ? workspaces.map(formatUsageLine).join("\n")
      : t("settings.hostSections.knowledgeBases.deleteBlockedUnknown");
  Alert.alert(
    t("settings.hostSections.knowledgeBases.deleteBlockedTitle"),
    t("settings.hostSections.knowledgeBases.deleteBlockedMessage", {
      slug: kb.slug,
      count: workspaces.length || kb.mountedWorkspaceCount || 1,
      list,
    }),
    [{ text: t("settings.hostSections.knowledgeBases.deleteBlockedOk") }],
  );
}

function KnowledgeBaseRow({
  kb,
  busy,
  canPickPaths,
  onExport,
  onDelete,
}: {
  kb: KnowledgeBase;
  busy: boolean;
  canPickPaths: boolean;
  onExport: (kb: KnowledgeBase) => void;
  onDelete: (kb: KnowledgeBase) => void;
}) {
  const { t } = useTranslation();
  const importedLabel = formatShortDate(kb.importedAt ?? kb.createdAt);
  const embeddedLabel = formatShortDate(kb.lastEmbeddedAt);
  const metaLine = t("settings.hostSections.knowledgeBases.rowMeta", {
    name: kb.name,
    id: kb.id,
  });
  const timingParts = [
    importedLabel
      ? t("settings.hostSections.knowledgeBases.importedAt", { date: importedLabel })
      : null,
    embeddedLabel
      ? t("settings.hostSections.knowledgeBases.embeddedAt", { date: embeddedLabel })
      : t("settings.hostSections.knowledgeBases.embeddedNever"),
  ].filter(Boolean);

  const handleExport = useCallback(() => {
    onExport(kb);
  }, [kb, onExport]);
  const handleDelete = useCallback(() => {
    onDelete(kb);
  }, [kb, onDelete]);

  const triggerStyle = useCallback(
    ({
      pressed,
      hovered,
      open,
    }: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) => [
      styles.menuButton,
      (hovered || open) && styles.menuButtonHovered,
      pressed && styles.menuButtonPressed,
    ],
    [],
  );

  return (
    <View style={[settingsStyles.card, styles.kbCard]} testID={`host-kb-row-${kb.slug}`}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{kb.slug}</Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {metaLine}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {timingParts.join(" · ")}
          </Text>
          {kb.importProvenance ? (
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              {kb.importProvenance}
            </Text>
          ) : null}
        </View>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            hitSlop={8}
            onPressIn={stopPressInPropagation}
            style={triggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("settings.hostSections.knowledgeBases.actionsMenu", {
              name: kb.name,
            })}
            testID={`host-kb-actions-${kb.slug}`}
          >
            {({ hovered, open }) => (
              <ThemedMoreHorizontal
                size={ICON_SIZE.sm}
                uniProps={hovered || open ? foregroundColorMapping : mutedColorMapping}
              />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={200}>
            {canPickPaths ? (
              <DropdownMenuItem
                leading={exportLeading}
                onSelect={handleExport}
                testID={`host-kb-export-${kb.slug}`}
              >
                {t("settings.hostSections.knowledgeBases.export")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              destructive
              leading={deleteLeading}
              onSelect={handleDelete}
              testID={`host-kb-delete-${kb.slug}`}
            >
              {t("settings.hostSections.knowledgeBases.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

function KnowledgeBasesBody({
  loadState,
  loadError,
  busy,
  connected,
  canPickPaths,
  onOpenImport,
  onExport,
  onDelete,
  onRetry,
}: {
  loadState: AggregateLoadState<KnowledgeBase>;
  loadError: string | null;
  busy: boolean;
  connected: boolean;
  canPickPaths: boolean;
  onOpenImport: () => void;
  onExport: (kb: KnowledgeBase) => void;
  onDelete: (kb: KnowledgeBase) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  if (loadState.status === "connecting" || loadState.status === "loading") {
    if (loadError) {
      return (
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={styles.errorText}>{loadError}</Text>
              <View style={styles.actions}>
                <Button size="sm" variant="secondary" onPress={onRetry} testID="host-kb-retry">
                  {t("common.actions.retry")}
                </Button>
              </View>
            </View>
          </View>
        </View>
      );
    }
    return (
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <Text style={settingsStyles.rowHint}>
            {loadState.status === "connecting"
              ? t("settings.hostSections.knowledgeBases.connecting")
              : t("settings.hostSections.knowledgeBases.loading")}
          </Text>
        </View>
      </View>
    );
  }

  if (loadState.data.length === 0) {
    return (
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.hostSections.knowledgeBases.emptyTitle")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.hostSections.knowledgeBases.emptyHint")}
            </Text>
            {!canPickPaths ? (
              <Text style={settingsStyles.rowHint}>
                {t("settings.hostSections.knowledgeBases.useDesktop")}
              </Text>
            ) : (
              <View style={styles.actions}>
                <Button
                  size="sm"
                  disabled={!connected || busy}
                  onPress={onOpenImport}
                  testID="host-kb-empty-import"
                >
                  {t("settings.hostSections.knowledgeBases.importAction")}
                </Button>
              </View>
            )}
          </View>
        </View>
      </View>
    );
  }

  return (
    <>
      {loadState.data.map((kb) => (
        <KnowledgeBaseRow
          key={kb.id}
          kb={kb}
          busy={busy}
          canPickPaths={canPickPaths}
          onExport={onExport}
          onDelete={onDelete}
        />
      ))}
      {!canPickPaths ? (
        <Text style={settingsStyles.rowHint}>
          {t("settings.hostSections.knowledgeBases.remoteHostHint")}
        </Text>
      ) : null}
    </>
  );
}

function ImportKnowledgeBaseSheet({
  visible,
  canPickPaths,
  importing,
  sourceKind,
  fromPath,
  slug,
  name,
  importError,
  onClose,
  onSourceKindChange,
  onSlugChange,
  onNameChange,
  onPickPath,
  onSubmit,
}: {
  visible: boolean;
  canPickPaths: boolean;
  importing: boolean;
  sourceKind: KnowledgeBaseImportSourceKind;
  fromPath: string | null;
  slug: string;
  name: string;
  importError: string | null;
  onClose: () => void;
  onSourceKindChange: (value: KnowledgeBaseImportSourceKind) => void;
  onSlugChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onPickPath: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.hostSections.knowledgeBases.importTitle") }),
    [t],
  );
  const sourceOptions = useMemo(
    () => [
      {
        value: "folder" as const,
        label: t("settings.hostSections.knowledgeBases.sourceFolder"),
        testID: "host-kb-import-source-folder",
      },
      {
        value: "package" as const,
        label: t("settings.hostSections.knowledgeBases.sourcePackage"),
        testID: "host-kb-import-source-package",
      },
    ],
    [t],
  );
  const footer = useMemo(
    () => (
      <View style={styles.sheetFooter}>
        <Button
          variant="secondary"
          onPress={onClose}
          disabled={importing}
          style={styles.footerButton}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={onSubmit}
          loading={importing}
          disabled={importing || !canPickPaths}
          style={styles.footerButton}
          testID="host-kb-import-submit"
        >
          {t("settings.hostSections.knowledgeBases.importSubmit")}
        </Button>
      </View>
    ),
    [canPickPaths, importing, onClose, onSubmit, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="host-kb-import-sheet"
      footer={footer}
    >
      <Field
        label={t("settings.hostSections.knowledgeBases.source")}
        hint={
          sourceKind === "folder"
            ? t("settings.hostSections.knowledgeBases.sourceFolderHint")
            : t("settings.hostSections.knowledgeBases.sourcePackageHint")
        }
        hintWrap
      >
        <SegmentedControl
          size="sm"
          value={sourceKind}
          onValueChange={onSourceKindChange}
          testID="host-kb-import-source"
          options={sourceOptions}
        />
      </Field>

      {canPickPaths ? (
        <View style={styles.pathRow}>
          <Button
            size="sm"
            variant="secondary"
            disabled={importing}
            onPress={onPickPath}
            testID="host-kb-import-pick"
          >
            {t("settings.hostSections.knowledgeBases.chooseFolder")}
          </Button>
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {fromPath ?? t("settings.hostSections.knowledgeBases.pathOnHost")}
          </Text>
        </View>
      ) : (
        <Text style={settingsStyles.rowHint}>
          {t("settings.hostSections.knowledgeBases.useDesktop")}
        </Text>
      )}

      <Field label={t("settings.hostSections.knowledgeBases.slug")}>
        <FormTextInput
          size="sm"
          value={slug}
          onChangeText={onSlugChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!importing}
          placeholder={t("settings.hostSections.knowledgeBases.slugPlaceholder")}
          testID="host-kb-import-slug"
        />
      </Field>

      <Field
        label={t("settings.hostSections.knowledgeBases.name")}
        hint={t("settings.hostSections.knowledgeBases.nameOptional")}
      >
        <FormTextInput
          size="sm"
          value={name}
          onChangeText={onNameChange}
          autoCapitalize="sentences"
          autoCorrect={false}
          editable={!importing}
          placeholder={t("settings.hostSections.knowledgeBases.namePlaceholder")}
          testID="host-kb-import-name"
        />
      </Field>

      <Text style={settingsStyles.rowHint}>
        {t("settings.hostSections.knowledgeBases.importHint")}
      </Text>
      {importError ? <Text style={styles.errorText}>{importError}</Text> : null}
      {importing ? (
        <Text style={settingsStyles.rowHint}>
          {t("settings.hostSections.knowledgeBases.importing")}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

export function HostKnowledgeBasesPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId) ?? null;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const canPickPaths = getIsElectron() && isLocalDaemon;
  const { loadState, refetch, supported, error: listError } = useKnowledgeBases(serverId);
  const loadError = listError ? toErrorMessage(listError) : null;

  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sourceKind, setSourceKind] = useState<KnowledgeBaseImportSourceKind>("folder");
  const [fromPath, setFromPath] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const resetImportForm = useCallback(() => {
    setSourceKind("folder");
    setFromPath(null);
    setSlug("");
    setName("");
    setImportError(null);
  }, []);

  const closeImport = useCallback(() => {
    if (importing) return;
    setImportOpen(false);
    resetImportForm();
  }, [importing, resetImportForm]);

  const openImport = useCallback(() => {
    resetImportForm();
    setImportOpen(true);
  }, [resetImportForm]);

  const handlePickImportPath = useCallback(() => {
    void (async () => {
      try {
        const path = await pickDirectory();
        if (path) {
          setFromPath(path);
          setImportError(null);
        }
      } catch (err) {
        toast.error(toErrorMessage(err));
      }
    })();
  }, [toast]);

  const handleImport = useCallback(() => {
    if (!client || importing) return;
    const trimmedSlug = slug.trim();
    if (!isValidKbMountSlug(trimmedSlug)) {
      setImportError(t("settings.hostSections.knowledgeBases.slugInvalid"));
      return;
    }
    if (!fromPath) {
      setImportError(t("settings.hostSections.knowledgeBases.fromPathRequired"));
      return;
    }
    const trimmedName = name.trim();
    setImporting(true);
    setImportError(null);
    void (async () => {
      try {
        const payload = await client.knowledgeBaseImport({
          slug: trimmedSlug,
          fromPath,
          sourceKind,
          ...(trimmedName ? { name: trimmedName } : {}),
        });
        if (payload.error || !payload.knowledgeBase) {
          setImportError(payload.error ?? t("settings.hostSections.knowledgeBases.importFailed"));
          return;
        }
        setImportOpen(false);
        resetImportForm();
        refetch();
        toast.show(
          t("settings.hostSections.knowledgeBases.importOk", {
            slug: payload.knowledgeBase.slug,
          }),
          { variant: "success" },
        );
      } catch (err) {
        setImportError(toErrorMessage(err));
      } finally {
        setImporting(false);
      }
    })();
  }, [client, fromPath, importing, name, refetch, resetImportForm, slug, sourceKind, t, toast]);

  const handleExport = useCallback(
    (kb: KnowledgeBase) => {
      if (!client || !canPickPaths) return;
      void (async () => {
        try {
          const outDir = await pickDirectory();
          if (!outDir) return;
          setBusy(true);
          const payload = await client.knowledgeBaseExport({
            idOrSlug: kb.id,
            outDir,
          });
          if (payload.error || !payload.outDir) {
            toast.error(payload.error ?? t("settings.hostSections.knowledgeBases.exportFailed"));
            return;
          }
          toast.show(t("settings.hostSections.knowledgeBases.exportOk", { path: payload.outDir }), {
            variant: "success",
          });
        } catch (err) {
          toast.error(toErrorMessage(err));
        } finally {
          setBusy(false);
        }
      })();
    },
    [canPickPaths, client, t, toast],
  );

  const handleDelete = useCallback(
    (kb: KnowledgeBase) => {
      if (!client) return;
      void (async () => {
        setBusy(true);
        try {
          const usagesPayload = await client.knowledgeBaseListUsages({ idOrSlug: kb.id });
          if (!usagesPayload.error && usagesPayload.workspaces.length > 0) {
            showDeleteBlockedAlert(kb, usagesPayload.workspaces, t);
            return;
          }

          const confirmed = await confirmDialog({
            title: t("settings.hostSections.knowledgeBases.deleteTitle"),
            message: t("settings.hostSections.knowledgeBases.deleteMessage", {
              name: kb.name || kb.slug,
            }),
            confirmLabel: t("settings.hostSections.knowledgeBases.delete"),
            cancelLabel: t("common.actions.cancel"),
            destructive: true,
          });
          if (!confirmed) return;

          const payload = await client.knowledgeBaseDelete({ idOrSlug: kb.id });
          if (payload.code === "still_mounted") {
            showDeleteBlockedAlert(kb, payload.workspaces ?? [], t);
            return;
          }
          if (payload.error || !payload.deleted) {
            toast.error(payload.error ?? t("settings.hostSections.knowledgeBases.deleteFailed"));
            return;
          }
          refetch();
          toast.show(t("settings.hostSections.knowledgeBases.deletedToast"), {
            variant: "success",
          });
        } catch (err) {
          toast.error(toErrorMessage(err));
        } finally {
          setBusy(false);
        }
      })();
    },
    [client, refetch, t, toast],
  );

  const sectionTrailing = useMemo(() => {
    if (!canPickPaths) return null;
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={!connected || busy || loadState.status !== "loaded"}
        onPress={openImport}
        testID="host-kb-import"
      >
        {t("settings.hostSections.knowledgeBases.importAction")}
      </Button>
    );
  }, [busy, canPickPaths, connected, loadState.status, openImport, t]);

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
        <SettingsSection title={t("settings.hostSections.knowledgeBases.title")}>
          <View style={settingsStyles.card}>
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>
                {t("settings.hostSections.knowledgeBases.unsupported")}
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
        title={t("settings.hostSections.knowledgeBases.title")}
        testID="host-knowledge-bases"
        trailing={sectionTrailing}
      >
        <KnowledgeBasesBody
          loadState={loadState}
          loadError={loadError}
          busy={busy}
          connected={connected}
          canPickPaths={canPickPaths}
          onOpenImport={openImport}
          onExport={handleExport}
          onDelete={handleDelete}
          onRetry={refetch}
        />
      </SettingsSection>

      <ImportKnowledgeBaseSheet
        visible={importOpen}
        canPickPaths={canPickPaths}
        importing={importing}
        sourceKind={sourceKind}
        fromPath={fromPath}
        slug={slug}
        name={name}
        importError={importError}
        onClose={closeImport}
        onSourceKindChange={setSourceKind}
        onSlugChange={setSlug}
        onNameChange={setName}
        onPickPath={handlePickImportPath}
        onSubmit={handleImport}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  kbCard: {
    marginBottom: 0,
  },
  pathRow: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
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
  sheetFooter: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
  menuButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  menuButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  menuButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
