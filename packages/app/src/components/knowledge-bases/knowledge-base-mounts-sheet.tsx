import { useCallback, useMemo, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react-native";
import type { KnowledgeBase, KnowledgeBaseMount } from "@getpaseo/protocol/knowledge-base/types";
import {
  AdaptiveModalSheet,
  SheetToneText,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { useToast } from "@/contexts/toast-context";
import {
  knowledgeBaseMountsQueryKey,
  useKnowledgeBaseMounts,
} from "@/knowledge-bases/use-knowledge-base-mounts";
import { useKnowledgeBases } from "@/knowledge-bases/use-knowledge-bases";
import { isValidKbMountSlug, vfsPathForMountSlug } from "@/knowledge-bases/mount-slug";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

export interface KnowledgeBaseMountsSheetProps {
  serverId: string;
  workspaceId: string;
  workspaceName: string;
  /** Soft-confirm unmount when agents are active in this workspace. */
  hasRunningAgents?: boolean;
  visible: boolean;
  onClose: () => void;
}

type SheetMode = "list" | "add";

function mountLabel(mount: KnowledgeBaseMount): string {
  return mount.name || mount.slug || mount.knowledgeBaseId;
}

function MountRow({
  mount,
  unmounting,
  onUnmount,
}: {
  mount: KnowledgeBaseMount;
  unmounting: boolean;
  onUnmount: (mount: KnowledgeBaseMount) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleUnmountPress = useCallback(() => {
    onUnmount(mount);
  }, [mount, onUnmount]);
  return (
    <View style={styles.row} testID={`kb-mount-row-${mount.mountSlug}`}>
      <View style={styles.rowText}>
        <SheetToneText tone="foreground" style={styles.rowTitle} numberOfLines={1}>
          {vfsPathForMountSlug(mount.mountSlug)}
        </SheetToneText>
        <SheetToneText style={styles.rowMeta} numberOfLines={1}>
          {mountLabel(mount)}
        </SheetToneText>
      </View>
      <Button
        size="sm"
        variant="secondary"
        onPress={handleUnmountPress}
        disabled={unmounting}
        loading={unmounting}
        testID={`kb-mount-unmount-${mount.mountSlug}`}
      >
        {t("knowledgeBases.mountsSheet.unmount")}
      </Button>
    </View>
  );
}

function AddMountForm({
  knowledgeBases,
  mountedKbIds,
  controlSize,
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  knowledgeBases: readonly KnowledgeBase[];
  mountedKbIds: ReadonlySet<string>;
  controlSize: FieldControlSize;
  isSubmitting: boolean;
  onCancel: () => void;
  onSubmit: (input: { idOrSlug: string; mountSlug: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const available = knowledgeBases.filter((kb) => !mountedKbIds.has(kb.id));
  const [selectedKbId, setSelectedKbId] = useState(available[0]?.id ?? "");
  const selectedKb = available.find((kb) => kb.id === selectedKbId) ?? available[0] ?? null;
  const [mountSlug, setMountSlug] = useState(selectedKb?.slug ?? "");

  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      available.map((kb) => ({
        id: kb.id,
        value: kb.id,
        label: kb.name || kb.slug,
      })),
    [available],
  );

  const selectedDisplay = useMemo(
    () => (selectedKb ? { label: selectedKb.name || selectedKb.slug } : null),
    [selectedKb],
  );

  const handleSelectKb = useCallback(
    (id: string) => {
      setSelectedKbId(id);
      const kb = available.find((entry) => entry.id === id);
      if (kb) {
        setMountSlug(kb.slug);
      }
    },
    [available],
  );

  const previewSlug = mountSlug.trim() || selectedKb?.slug || "";
  const canSubmit =
    Boolean(selectedKb) && isValidKbMountSlug(previewSlug) && !isSubmitting && available.length > 0;

  const handleSubmit = useCallback(() => {
    if (!selectedKb) return;
    onSubmit({ idOrSlug: selectedKb.slug, mountSlug: previewSlug });
  }, [onSubmit, previewSlug, selectedKb]);

  if (knowledgeBases.length === 0) {
    return (
      <SheetToneText style={styles.emptyText} testID="kb-add-mount-empty-catalog">
        {t("knowledgeBases.emptyCatalog")}
      </SheetToneText>
    );
  }

  if (available.length === 0) {
    return (
      <SheetToneText style={styles.emptyText} testID="kb-add-mount-none-available">
        {t("knowledgeBases.mountsSheet.noAvailable")}
      </SheetToneText>
    );
  }

  return (
    <View style={styles.addForm} testID="kb-add-mount-form">
      <SelectField
        label={t("knowledgeBases.mountsSheet.knowledgeBase")}
        size={controlSize}
        value={selectedKb?.id ?? null}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={handleSelectKb}
        placeholder={t("knowledgeBases.mountsSheet.knowledgeBase")}
        emptyText={t("common.empty.noResults")}
        testID="kb-add-mount-kb-select"
      />
      <Field label={t("knowledgeBases.mountSlug")}>
        <FormTextInput
          size={controlSize}
          testID="kb-add-mount-slug-input"
          accessibilityLabel={t("knowledgeBases.mountSlug")}
          value={mountSlug}
          onChangeText={setMountSlug}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
        />
      </Field>
      {previewSlug ? (
        <SheetToneText style={styles.pathHint}>
          {t("knowledgeBases.mountsSheet.agentsSee", { slug: previewSlug })}
        </SheetToneText>
      ) : null}
      <View style={styles.footer}>
        <Button
          size={controlSize}
          style={styles.footerButton}
          variant="secondary"
          onPress={onCancel}
          disabled={isSubmitting}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          size={controlSize}
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="kb-add-mount-submit"
        >
          {t("knowledgeBases.mountsSheet.mount")}
        </Button>
      </View>
    </View>
  );
}

/**
 * Workspace kebab → Mount knowledge bases. List / add / unmount mounts for one workspace.
 * Fresh mount per open via `key` on the caller.
 */
export function KnowledgeBaseMountsSheet({
  serverId,
  workspaceId,
  workspaceName,
  hasRunningAgents = false,
  visible,
  onClose,
}: KnowledgeBaseMountsSheetProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [mode, setMode] = useState<SheetMode>("list");
  const [pendingUnmountSlug, setPendingUnmountSlug] = useState<string | null>(null);
  const [isMounting, setIsMounting] = useState(false);
  const openAddMode = useCallback(() => setMode("add"), []);
  const openListMode = useCallback(() => setMode("list"), []);

  const catalog = useKnowledgeBases(serverId);
  const mountsQuery = useKnowledgeBaseMounts({ serverId, workspaceId });
  const loadError = catalog.error ?? mountsQuery.error;

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: knowledgeBaseMountsQueryKey(serverId, workspaceId),
    });
  }, [queryClient, serverId, workspaceId]);

  const header = useMemo<SheetHeader>(() => {
    if (mode === "add") {
      return {
        title: t("knowledgeBases.mountsSheet.addTitle"),
        back: {
          onPress: openListMode,
          accessibilityLabel: t("common.actions.back"),
        },
      };
    }
    return {
      title: t("knowledgeBases.mountKnowledgeBases"),
      subtitle: t("knowledgeBases.mountsSheet.workspaceLabel", { name: workspaceName }),
    };
  }, [mode, openListMode, t, workspaceName]);

  const mountedKbIds = useMemo(
    () => new Set(mountsQuery.mounts.map((mount) => mount.knowledgeBaseId)),
    [mountsQuery.mounts],
  );

  const handleUnmount = useCallback(
    (mount: KnowledgeBaseMount) => {
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      void (async () => {
        if (hasRunningAgents) {
          const confirmed = await confirmDialog({
            title: t("knowledgeBases.mountsSheet.unmountConfirmTitle"),
            message: t("knowledgeBases.mountsSheet.unmountConfirmRunningMessage", {
              slug: mount.mountSlug,
            }),
            confirmLabel: t("knowledgeBases.mountsSheet.unmountConfirm"),
            cancelLabel: t("common.actions.cancel"),
          });
          if (!confirmed) return;
        }

        setPendingUnmountSlug(mount.mountSlug);
        try {
          const payload = await client.knowledgeBaseUnmount({
            workspaceId,
            mountSlugOrKbId: mount.mountSlug,
          });
          if (payload.error) {
            throw new Error(payload.error);
          }
          await invalidate();
        } catch (error) {
          toast.error(toErrorMessage(error));
        } finally {
          setPendingUnmountSlug(null);
        }
      })();
    },
    [client, hasRunningAgents, invalidate, t, toast, workspaceId],
  );

  const handleMount = useCallback(
    (input: { idOrSlug: string; mountSlug: string }) => {
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      setIsMounting(true);
      void (async () => {
        try {
          const payload = await client.knowledgeBaseMount({
            workspaceId,
            idOrSlug: input.idOrSlug,
            mountSlug: input.mountSlug,
          });
          if (payload.error) {
            throw new Error(payload.error);
          }
          await invalidate();
          openListMode();
        } catch (error) {
          toast.error(toErrorMessage(error));
        } finally {
          setIsMounting(false);
        }
      })();
    },
    [client, invalidate, openListMode, t, toast, workspaceId],
  );

  const listBody = useMemo(() => {
    const catalogLoading = catalog.loadState.status !== "loaded";
    const mountsLoading = mountsQuery.loadState.status !== "loaded";
    if (catalogLoading || mountsLoading) {
      if (loadError) {
        return (
          <SheetToneText style={styles.emptyText} testID="kb-mounts-load-error">
            {toErrorMessage(loadError)}
          </SheetToneText>
        );
      }
      return (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      );
    }

    if (mountsQuery.mounts.length === 0) {
      return (
        <SheetToneText style={styles.emptyText} testID="kb-mounts-empty">
          {t("knowledgeBases.mountsSheet.empty")}
        </SheetToneText>
      );
    }

    return (
      <View style={styles.list}>
        <SheetToneText style={styles.sectionLabel}>
          {t("knowledgeBases.mountsSheet.mounted")}
        </SheetToneText>
        {mountsQuery.mounts.map((mount) => (
          <MountRow
            key={`${mount.knowledgeBaseId}:${mount.mountSlug}`}
            mount={mount}
            unmounting={pendingUnmountSlug === mount.mountSlug}
            onUnmount={handleUnmount}
          />
        ))}
      </View>
    );
  }, [
    catalog.loadState.status,
    handleUnmount,
    loadError,
    mountsQuery.loadState.status,
    mountsQuery.mounts,
    pendingUnmountSlug,
    t,
  ]);

  const footer = useMemo(() => {
    if (mode !== "list") {
      return null;
    }
    return (
      <View style={styles.footer}>
        <View style={styles.footerSpring} />
        <Button size={controlSize} variant="default" onPress={onClose} testID="kb-mounts-done">
          {t("knowledgeBases.mountsSheet.done")}
        </Button>
      </View>
    );
  }, [controlSize, mode, onClose, t]);

  if (!visible) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      webScrollbar
      testID="kb-mounts-sheet"
    >
      {mode === "list" ? (
        <>
          {listBody}
          <Button
            variant="outline"
            leftIcon={Plus}
            onPress={openAddMode}
            disabled={catalog.loadState.status !== "loaded"}
            testID="kb-mounts-add"
          >
            {t("knowledgeBases.mountsSheet.add")}
          </Button>
          <SheetToneText style={styles.immutableHint}>
            {t("knowledgeBases.mountsSheet.slugImmutable")}
          </SheetToneText>
        </>
      ) : (
        <AddMountForm
          knowledgeBases={catalog.knowledgeBases}
          mountedKbIds={mountedKbIds}
          controlSize={controlSize}
          isSubmitting={isMounting}
          onCancel={openListMode}
          onSubmit={handleMount}
        />
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[8],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  list: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[1],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  immutableHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[3],
  },
  addForm: {
    gap: theme.spacing[3],
  },
  pathHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  footerSpring: {
    flex: 1,
  },
  footerButton: {
    flex: 1,
  },
}));
