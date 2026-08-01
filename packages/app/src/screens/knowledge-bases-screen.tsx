import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  KnowledgeBase,
  KnowledgeBaseImportSourceKind,
  KnowledgeBaseUsage,
} from "@getpaseo/protocol/knowledge-base/types";
import { BookOpen, ChevronDown, Download, MoreHorizontal, Plus, Trash2 } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostPicker, HostStatusDotSlot } from "@/components/hosts/host-picker";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { getIsElectron } from "@/constants/platform";
import { pickDirectory } from "@/desktop/pick-directory";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import {
  resolveKnowledgeBaseHostSelection,
  resolveKnowledgeBaseRowTitle,
} from "@/knowledge-bases/knowledge-base-hub-row";
import { isValidKbMountSlug } from "@/knowledge-bases/mount-slug";
import { withEmbeddingsConfigHint } from "@/knowledge-bases/embeddings-error-hint";
import { resolveKnowledgeBaseCreate } from "@/knowledge-bases/resolve-knowledge-base-create";
import { useKnowledgeBases } from "@/knowledge-bases/use-knowledge-bases";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import type { AggregateLoadState } from "@/schedules/aggregated-schedules";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { buildKnowledgeBaseDetailRoute } from "@/utils/host-routes";

const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedDownload = withUnistyles(Download);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedChevronDown = withUnistyles(ChevronDown);

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

type CreateMode = "empty" | "import";

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
  onExport,
  onDelete,
  onOpen,
}: {
  kb: KnowledgeBase;
  busy: boolean;
  onExport: (kb: KnowledgeBase) => void;
  onDelete: (kb: KnowledgeBase) => void;
  onOpen: (kb: KnowledgeBase) => void;
}) {
  const { t } = useTranslation();
  const title = resolveKnowledgeBaseRowTitle(kb);
  const importedLabel = formatShortDate(kb.importedAt ?? kb.createdAt);
  const embeddedLabel = formatShortDate(kb.lastEmbeddedAt);
  const metaLine = t("settings.hostSections.knowledgeBases.rowMeta", {
    slug: kb.slug,
    id: kb.id,
  });
  const mountedCount = kb.mountedWorkspaceCount ?? 0;
  const usageLine =
    mountedCount > 0
      ? t("knowledgeBases.detail.mountedOn", { count: mountedCount })
      : t("knowledgeBases.notMounted");
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
  const handleOpen = useCallback(() => {
    onOpen(kb);
  }, [kb, onOpen]);

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
    <Pressable
      style={[settingsStyles.card, styles.kbCard]}
      onPress={handleOpen}
      testID={`kb-row-${kb.slug}`}
      accessibilityRole="button"
    >
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{title}</Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {metaLine}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {usageLine}
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
              name: title,
            })}
            testID={`kb-actions-${kb.slug}`}
          >
            {({ hovered, open }) => (
              <ThemedMoreHorizontal
                size={ICON_SIZE.sm}
                uniProps={hovered || open ? foregroundColorMapping : mutedColorMapping}
              />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={200}>
            <DropdownMenuItem
              leading={exportLeading}
              onSelect={handleExport}
              testID={`kb-export-${kb.slug}`}
            >
              {t("settings.hostSections.knowledgeBases.export")}
            </DropdownMenuItem>
            <DropdownMenuItem
              destructive
              leading={deleteLeading}
              onSelect={handleDelete}
              testID={`kb-delete-${kb.slug}`}
            >
              {t("settings.hostSections.knowledgeBases.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </Pressable>
  );
}

function KnowledgeBasesBody({
  loadState,
  loadError,
  busy,
  connected,
  canPickPaths,
  onOpenCreate,
  onExport,
  onDelete,
  onOpen,
  onRetry,
}: {
  loadState: AggregateLoadState<KnowledgeBase>;
  loadError: string | null;
  busy: boolean;
  connected: boolean;
  canPickPaths: boolean;
  onOpenCreate: () => void;
  onExport: (kb: KnowledgeBase) => void;
  onDelete: (kb: KnowledgeBase) => void;
  onOpen: (kb: KnowledgeBase) => void;
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (loadState.status === "connecting" || loadState.status === "loading") {
    if (loadError) {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{loadError}</Text>
          <Button size="sm" variant="secondary" onPress={onRetry} testID="kb-retry">
            {t("common.actions.retry")}
          </Button>
        </View>
      );
    }
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
        <Text style={styles.message}>
          {loadState.status === "connecting"
            ? t("settings.hostSections.knowledgeBases.connecting")
            : t("settings.hostSections.knowledgeBases.loading")}
        </Text>
      </View>
    );
  }

  if (loadState.data.length === 0) {
    return (
      <View style={styles.centered} testID="kb-empty">
        <BookOpen size={32} color={styles.message.color} />
        <Text style={styles.emptyTitle}>
          {t("settings.hostSections.knowledgeBases.emptyTitle")}
        </Text>
        <Text style={styles.message}>{t("settings.hostSections.knowledgeBases.emptyHint")}</Text>
        {!canPickPaths ? (
          <Text style={styles.message}>{t("settings.hostSections.knowledgeBases.useDesktop")}</Text>
        ) : null}
        <Button
          size="sm"
          leftIcon={Plus}
          disabled={!connected || busy}
          onPress={onOpenCreate}
          testID="kb-empty-new"
        >
          {t("knowledgeBases.newAction")}
        </Button>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      testID="kb-list"
    >
      {loadState.data.map((kb) => (
        <KnowledgeBaseRow
          key={kb.id}
          kb={kb}
          busy={busy}
          onExport={onExport}
          onDelete={onDelete}
          onOpen={onOpen}
        />
      ))}
      {!canPickPaths ? (
        <Text style={styles.remoteHint}>
          {t("settings.hostSections.knowledgeBases.remoteHostHint")}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function NewKnowledgeBaseSheet({
  visible,
  canPickPaths,
  createSupported,
  submitting,
  mode,
  sourceKind,
  fromPath,
  slug,
  name,
  formError,
  onClose,
  onModeChange,
  onSourceKindChange,
  onSlugChange,
  onNameChange,
  onPickPath,
  onSubmit,
}: {
  visible: boolean;
  canPickPaths: boolean;
  createSupported: boolean;
  submitting: boolean;
  mode: CreateMode;
  sourceKind: KnowledgeBaseImportSourceKind;
  fromPath: string | null;
  slug: string;
  name: string;
  formError: string | null;
  onClose: () => void;
  onModeChange: (value: CreateMode) => void;
  onSourceKindChange: (value: KnowledgeBaseImportSourceKind) => void;
  onSlugChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onPickPath: () => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("knowledgeBases.newTitle") }), [t]);
  const modeOptions = useMemo(
    () => [
      {
        value: "empty" as const,
        label: t("knowledgeBases.modeEmpty"),
        testID: "kb-new-mode-empty",
      },
      {
        value: "import" as const,
        label: t("knowledgeBases.modeImport"),
        testID: "kb-new-mode-import",
      },
    ],
    [t],
  );
  const sourceOptions = useMemo(
    () => [
      {
        value: "folder" as const,
        label: t("settings.hostSections.knowledgeBases.sourceFolder"),
        testID: "kb-import-source-folder",
      },
      {
        value: "package" as const,
        label: t("settings.hostSections.knowledgeBases.sourcePackage"),
        testID: "kb-import-source-package",
      },
    ],
    [t],
  );

  const submitDisabled =
    submitting ||
    (mode === "empty" ? !createSupported : !canPickPaths) ||
    (mode === "import" && !canPickPaths);

  const footer = useMemo(
    () => (
      <View style={styles.sheetFooter}>
        <Button
          variant="secondary"
          onPress={onClose}
          disabled={submitting}
          style={styles.footerButton}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={onSubmit}
          loading={submitting}
          disabled={submitDisabled}
          style={styles.footerButton}
          testID="kb-new-submit"
        >
          {mode === "empty"
            ? t("knowledgeBases.createSubmit")
            : t("settings.hostSections.knowledgeBases.importSubmit")}
        </Button>
      </View>
    ),
    [mode, onClose, onSubmit, submitDisabled, submitting, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="kb-new-sheet"
      footer={footer}
    >
      <Field label={t("knowledgeBases.modeLabel")}>
        <SegmentedControl
          size="sm"
          value={mode}
          onValueChange={onModeChange}
          testID="kb-new-mode"
          options={modeOptions}
        />
      </Field>

      {mode === "import" ? (
        <>
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
              testID="kb-import-source"
              options={sourceOptions}
            />
          </Field>

          {canPickPaths ? (
            <View style={styles.pathRow}>
              <Button
                size="sm"
                variant="secondary"
                disabled={submitting}
                onPress={onPickPath}
                testID="kb-import-pick"
              >
                {t("settings.hostSections.knowledgeBases.chooseFolder")}
              </Button>
              <Text style={styles.message} numberOfLines={2}>
                {fromPath ?? t("settings.hostSections.knowledgeBases.pathOnHost")}
              </Text>
            </View>
          ) : (
            <Text style={styles.message}>
              {t("settings.hostSections.knowledgeBases.useDesktop")}
            </Text>
          )}
        </>
      ) : null}

      <Field label={t("settings.hostSections.knowledgeBases.slug")}>
        <FormTextInput
          size="sm"
          value={slug}
          onChangeText={onSlugChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!submitting}
          placeholder={t("settings.hostSections.knowledgeBases.slugPlaceholder")}
          testID="kb-new-slug"
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
          editable={!submitting}
          placeholder={t("settings.hostSections.knowledgeBases.namePlaceholder")}
          testID="kb-new-name"
        />
      </Field>

      {mode === "empty" ? (
        <Text style={styles.message}>
          {createSupported ? t("knowledgeBases.emptyHint") : t("knowledgeBases.createUnavailable")}
        </Text>
      ) : (
        <Text style={styles.message}>{t("settings.hostSections.knowledgeBases.importHint")}</Text>
      )}
      {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
      {submitting ? (
        <Text style={styles.message}>
          {mode === "empty"
            ? t("knowledgeBases.creating")
            : t("settings.hostSections.knowledgeBases.importing")}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function KnowledgeBaseHostPicker({
  hosts,
  selectedHost,
  onSelectHost,
}: {
  hosts: HostProfile[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View | null>(null);
  const selected = hosts.find((host) => host.serverId === selectedHost) ?? hosts[0];
  const handleOpen = useCallback(() => setOpen(true), []);

  return (
    <HostPicker
      hosts={hosts}
      value={selectedHost}
      onSelect={onSelectHost}
      open={open}
      onOpenChange={setOpen}
      anchorRef={triggerRef}
      searchable={false}
      title={t("knowledgeBases.switchHost")}
      desktopPlacement="bottom-start"
      desktopMinWidth={240}
    >
      <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={t("knowledgeBases.switchHost")}
        testID="kb-host-picker"
        style={styles.hostTrigger}
        onPress={handleOpen}
      >
        {selected ? <HostStatusDotSlot serverId={selected.serverId} /> : null}
        <Text style={styles.hostName} numberOfLines={1}>
          {selected?.label ?? selectedHost}
        </Text>
        <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
      </Pressable>
    </HostPicker>
  );
}

export function KnowledgeBasesScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <KnowledgeBasesScreenContent />;
}

function KnowledgeBasesScreenContent(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const params = useLocalSearchParams<{ serverId?: string | string[] }>();
  const routeServerId = useMemo(() => {
    const raw = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
    return typeof raw === "string" ? raw.trim() : "";
  }, [params.serverId]);
  const appliedRouteServerIdRef = useRef<string | null>(null);
  const [selectedHost, setSelectedHost] = useState(() =>
    resolveKnowledgeBaseHostSelection({
      hosts,
      preferredServerId: routeServerId,
    }),
  );

  useEffect(() => {
    if (hosts.length === 0) {
      setSelectedHost("");
      appliedRouteServerIdRef.current = null;
      return;
    }
    if (routeServerId && routeServerId !== appliedRouteServerIdRef.current) {
      const next = resolveKnowledgeBaseHostSelection({
        hosts,
        preferredServerId: routeServerId,
        currentServerId: selectedHost,
      });
      if (next === routeServerId) {
        appliedRouteServerIdRef.current = routeServerId;
        if (next !== selectedHost) {
          setSelectedHost(next);
        }
        return;
      }
    }
    if (!hosts.some((host) => host.serverId === selectedHost)) {
      setSelectedHost(
        resolveKnowledgeBaseHostSelection({
          hosts,
          preferredServerId: routeServerId,
        }),
      );
    }
  }, [hosts, routeServerId, selectedHost]);

  const serverId = selectedHost.trim().length > 0 ? selectedHost : null;
  const client = useHostRuntimeClient(selectedHost);
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const connected = connectionStatus === "online";
  const isLocalDaemon = useIsLocalDaemon(selectedHost);
  const canPickPaths = getIsElectron() && isLocalDaemon;
  const { loadState, refetch, supported, error: listError } = useKnowledgeBases(serverId);
  const loadError = listError ? toErrorMessage(listError) : null;

  const [createSupported, setCreateSupported] = useState(
    () => resolveKnowledgeBaseCreate(client) !== null,
  );
  useEffect(() => {
    setCreateSupported(resolveKnowledgeBaseCreate(client) !== null);
  }, [client]);

  // Poll for K1a `knowledgeBaseCreate` while the Empty CTA is unavailable.
  useEffect(() => {
    if (createSupported) return;
    const timer = setInterval(() => {
      setCreateSupported(resolveKnowledgeBaseCreate(client) !== null);
    }, 2_000);
    return () => clearInterval(timer);
  }, [client, createSupported]);

  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<CreateMode>("empty");
  const [sourceKind, setSourceKind] = useState<KnowledgeBaseImportSourceKind>("folder");
  const [fromPath, setFromPath] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setMode("empty");
    setSourceKind("folder");
    setFromPath(null);
    setSlug("");
    setName("");
    setFormError(null);
  }, []);

  const closeSheet = useCallback(() => {
    if (submitting) return;
    setSheetOpen(false);
    resetForm();
  }, [resetForm, submitting]);

  const openCreate = useCallback(() => {
    resetForm();
    setSheetOpen(true);
  }, [resetForm]);

  const handlePickImportPath = useCallback(() => {
    void (async () => {
      try {
        const path = await pickDirectory();
        if (path) {
          setFromPath(path);
          setFormError(null);
        }
      } catch (err) {
        toast.error(toErrorMessage(err));
      }
    })();
  }, [toast]);

  const handleSubmit = useCallback(() => {
    if (!client || submitting) return;
    const trimmedSlug = slug.trim();
    if (!isValidKbMountSlug(trimmedSlug)) {
      setFormError(t("settings.hostSections.knowledgeBases.slugInvalid"));
      return;
    }
    const trimmedName = name.trim();

    if (mode === "empty") {
      const create = resolveKnowledgeBaseCreate(client);
      if (!create) {
        setFormError(t("knowledgeBases.createUnavailable"));
        return;
      }
      setSubmitting(true);
      setFormError(null);
      void (async () => {
        try {
          const payload = await create({
            slug: trimmedSlug,
            ...(trimmedName ? { name: trimmedName } : {}),
          });
          if (payload.error || !payload.knowledgeBase) {
            setFormError(payload.error ?? t("knowledgeBases.createFailed"));
            return;
          }
          setSheetOpen(false);
          resetForm();
          refetch();
          toast.show(t("knowledgeBases.createOk", { slug: payload.knowledgeBase.slug }), {
            variant: "success",
          });
          router.push(buildKnowledgeBaseDetailRoute(payload.knowledgeBase.id));
        } catch (err) {
          setFormError(toErrorMessage(err));
        } finally {
          setSubmitting(false);
        }
      })();
      return;
    }

    if (!fromPath) {
      setFormError(t("settings.hostSections.knowledgeBases.fromPathRequired"));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    void (async () => {
      try {
        const payload = await client.knowledgeBaseImport({
          slug: trimmedSlug,
          fromPath,
          sourceKind,
          ...(trimmedName ? { name: trimmedName } : {}),
        });
        if (payload.error || !payload.knowledgeBase) {
          setFormError(
            withEmbeddingsConfigHint({
              error: payload.error ?? t("settings.hostSections.knowledgeBases.importFailed"),
              hint: t("settings.hostSections.knowledgeBases.embeddings.configureHint"),
            }),
          );
          return;
        }
        setSheetOpen(false);
        resetForm();
        refetch();
        toast.show(
          t("settings.hostSections.knowledgeBases.importOk", {
            slug: payload.knowledgeBase.slug,
          }),
          { variant: "success" },
        );
      } catch (err) {
        setFormError(toErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
    })();
  }, [client, fromPath, mode, name, refetch, resetForm, slug, sourceKind, submitting, t, toast]);

  const handleExport = useCallback(
    (kb: KnowledgeBase) => {
      if (!canPickPaths) {
        toast.show(
          t("settings.hostSections.knowledgeBases.exportCliHint", {
            slug: kb.slug,
          }),
        );
        return;
      }
      if (!client) return;
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

  const handleOpen = useCallback((kb: KnowledgeBase) => {
    router.push(buildKnowledgeBaseDetailRoute(kb.id));
  }, []);

  const showUnsupported = Boolean(serverId && connected && !supported);
  const showNoHost = hosts.length === 0;
  const showHostPicker = hosts.length > 1;

  let body: ReactElement;
  if (showNoHost) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("knowledgeBases.noHost")}</Text>
      </View>
    );
  } else if (showUnsupported) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("knowledgeBases.unsupported")}</Text>
      </View>
    );
  } else {
    body = (
      <View style={styles.body}>
        <View style={styles.toolbar}>
          <View style={styles.toolbarLeft}>
            {showHostPicker ? (
              <KnowledgeBaseHostPicker
                hosts={hosts}
                selectedHost={selectedHost}
                onSelectHost={setSelectedHost}
              />
            ) : null}
          </View>
          <Button
            variant="outline"
            leftIcon={Plus}
            onPress={openCreate}
            size="sm"
            disabled={!connected || busy || loadState.status !== "loaded"}
            testID="kb-new"
          >
            {t("knowledgeBases.newAction")}
          </Button>
        </View>
        <KnowledgeBasesBody
          loadState={loadState}
          loadError={loadError}
          busy={busy}
          connected={connected}
          canPickPaths={canPickPaths}
          onOpenCreate={openCreate}
          onExport={handleExport}
          onDelete={handleDelete}
          onOpen={handleOpen}
          onRetry={refetch}
        />
      </View>
    );
  }

  return (
    <View style={styles.container} testID="knowledge-bases-screen">
      <MenuHeader title={t("knowledgeBases.title")} />
      {body}

      <NewKnowledgeBaseSheet
        visible={sheetOpen}
        canPickPaths={canPickPaths}
        createSupported={createSupported}
        submitting={submitting}
        mode={mode}
        sourceKind={sourceKind}
        fromPath={fromPath}
        slug={slug}
        name={name}
        formError={formError}
        onClose={closeSheet}
        onModeChange={setMode}
        onSourceKindChange={setSourceKind}
        onSlugChange={setSlug}
        onNameChange={setName}
        onPickPath={handlePickImportPath}
        onSubmit={handleSubmit}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  body: {
    flex: 1,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  toolbarLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hostTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    maxWidth: 240,
  },
  hostName: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[2],
  },
  kbCard: {
    marginBottom: 0,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    textAlign: "center",
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  remoteHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
  },
  pathRow: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
    textAlign: "center",
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
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
