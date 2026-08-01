import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  KnowledgeBase,
  KnowledgeBaseSearchHit,
  KnowledgeBaseSearchMode,
  KnowledgeBaseTreeNode,
  KnowledgeBaseUsage,
} from "@getpaseo/protocol/knowledge-base/types";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import { HostPicker, HostStatusDotSlot } from "@/components/hosts/host-picker";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import { pickDirectory } from "@/desktop/pick-directory";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import {
  KnowledgeBasePagePathSheet,
  type KnowledgeBasePagePathSheetMode,
} from "@/knowledge-bases/knowledge-base-page-path-sheet";
import {
  buildKnowledgeBaseTree,
  filterVisibleKnowledgeBaseTree,
  flattenKnowledgeBaseTree,
  type KnowledgeBaseTreeItem,
} from "@/knowledge-bases/knowledge-base-tree";
import { withEmbeddingsConfigHint } from "@/knowledge-bases/embeddings-error-hint";
import { resolveKnowledgeBaseMountTarget } from "@/knowledge-bases/resolve-knowledge-base-mount-target";
import {
  useKnowledgeBaseDetailApis,
  useKnowledgeBasePage,
  useKnowledgeBasePageAuthoringApis,
  useKnowledgeBaseRecord,
  useKnowledgeBaseSearch,
  useKnowledgeBaseTree,
  useKnowledgeBaseUsages,
} from "@/knowledge-bases/use-knowledge-base-detail";
import {
  useKnowledgeBasePageAuthoring,
  type KnowledgeBasePaneMode,
} from "@/knowledge-bases/use-knowledge-base-page-authoring";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { requestOpenKnowledgeBaseMountsSheet } from "@/stores/knowledge-base-mounts-sheet-request-store";
import { ICON_SIZE } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { buildKnowledgeBasesRoute } from "@/utils/host-routes";

const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedDownload = withUnistyles(Download);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedFolder = withUnistyles(Folder);
const ThemedFileText = withUnistyles(FileText);

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

function formatUsageLine(usage: KnowledgeBaseUsage): string {
  const title = usage.title?.trim() || usage.workspaceId;
  return `${title} · /paseo-vfs/${usage.mountSlug}`;
}

function showDeleteBlockedAlert(
  kb: KnowledgeBase,
  workspaces: KnowledgeBaseUsage[],
  t: (key: string, options?: Record<string, string | number>) => string,
): void {
  const list =
    workspaces.length > 0
      ? workspaces.map((usage) => `• ${formatUsageLine(usage)}`).join("\n")
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
        testID="kb-detail-host-picker"
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

function TreeChevron({ isDirectory, expanded }: { isDirectory: boolean; expanded: boolean }) {
  if (!isDirectory) {
    return <View style={styles.treeChevronSpacer} />;
  }
  if (expanded) {
    return <ThemedChevronDown size={14} uniProps={mutedColorMapping} />;
  }
  return <ThemedChevronRight size={14} uniProps={mutedColorMapping} />;
}

function TreeKindIcon({ isDirectory }: { isDirectory: boolean }) {
  if (isDirectory) {
    return <ThemedFolder size={14} uniProps={mutedColorMapping} />;
  }
  return <ThemedFileText size={14} uniProps={mutedColorMapping} />;
}

function TreeRow({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  node: KnowledgeBaseTreeNode;
  depth: number;
  selected: boolean;
  expanded: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): ReactElement {
  const isDirectory = node.kind === "directory";
  const handlePress = useCallback(() => {
    if (isDirectory) {
      onToggle(node.path);
      return;
    }
    onSelect(node.path);
  }, [isDirectory, node.path, onSelect, onToggle]);

  return (
    <Pressable
      onPress={handlePress}
      style={[styles.treeRow, selected && styles.treeRowSelected]}
      accessibilityRole="button"
      testID={`kb-tree-${node.path}`}
    >
      <View style={[styles.treeRowInner, { paddingLeft: 8 + depth * 14 }]}>
        <TreeChevron isDirectory={isDirectory} expanded={expanded} />
        <TreeKindIcon isDirectory={isDirectory} />
        <Text style={[styles.treeLabel, selected && styles.treeLabelSelected]} numberOfLines={1}>
          {node.name}
        </Text>
      </View>
    </Pressable>
  );
}

function UsagesList({ workspaces }: { workspaces: KnowledgeBaseUsage[] }): ReactElement {
  const { t } = useTranslation();
  if (workspaces.length === 0) {
    return <Text style={styles.usagesEmpty}>{t("knowledgeBases.detail.notMountedYet")}</Text>;
  }
  return (
    <>
      {workspaces.map((usage) => (
        <Text
          key={`${usage.workspaceId}:${usage.mountSlug}`}
          style={styles.usageRow}
          numberOfLines={2}
        >
          {formatUsageLine(usage)}
        </Text>
      ))}
    </>
  );
}

function UsagesPanel({
  serverId,
  knowledgeBaseId,
  workspaces,
  isLoading,
  mountedCount,
}: {
  serverId: string | null;
  knowledgeBaseId: string | null;
  workspaces: KnowledgeBaseUsage[];
  isLoading: boolean;
  mountedCount: number;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const lastWorkspaceSelection = useLastWorkspaceSelection();

  const handleMountInCurrentWorkspace = useCallback(() => {
    if (!serverId) {
      toast.show(t("knowledgeBases.detail.openWorkspaceFirstToast"));
      return;
    }
    const target = resolveKnowledgeBaseMountTarget({
      detailServerId: serverId,
      active: activeWorkspaceSelection,
      last: lastWorkspaceSelection,
    });
    if (!target) {
      toast.show(t("knowledgeBases.detail.openWorkspaceFirstToast"));
      return;
    }
    navigateToWorkspace({
      serverId: target.serverId,
      workspaceId: target.workspaceId,
    });
    requestOpenKnowledgeBaseMountsSheet({
      serverId: target.serverId,
      workspaceId: target.workspaceId,
      ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
    });
  }, [activeWorkspaceSelection, knowledgeBaseId, lastWorkspaceSelection, serverId, t, toast]);

  const body = isLoading ? (
    <LoadingSpinner size="small" color={styles.spinner.color} />
  ) : (
    <UsagesList workspaces={workspaces} />
  );

  return (
    <View style={styles.usagesPanel} testID="kb-detail-usages">
      <Text style={styles.usagesSummary}>
        {t("knowledgeBases.detail.mountedOn", { count: mountedCount })}
      </Text>
      <Text style={styles.usagesHint}>{t("knowledgeBases.detail.mountsManagedHint")}</Text>
      <Button
        size="sm"
        variant="secondary"
        onPress={handleMountInCurrentWorkspace}
        testID="kb-detail-mount-in-workspace"
      >
        {t("knowledgeBases.detail.mountInCurrentWorkspace")}
      </Button>
      {body}
    </View>
  );
}

function SearchHitRow({
  hit,
  onSelect,
}: {
  hit: KnowledgeBaseSearchHit;
  onSelect: (path: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => {
    onSelect(hit.path);
  }, [hit.path, onSelect]);

  return (
    <Pressable
      onPress={handlePress}
      style={styles.searchHit}
      accessibilityRole="button"
      testID={`kb-search-hit-${hit.path}`}
    >
      <Text style={styles.searchHitPath} numberOfLines={1}>
        {hit.path}
      </Text>
      <Text style={styles.searchHitSnippet} numberOfLines={2}>
        {hit.snippet}
      </Text>
    </Pressable>
  );
}

function SearchResults({
  query,
  hits,
  isLoading,
  error,
  onSelect,
}: {
  query: string;
  hits: KnowledgeBaseSearchHit[];
  isLoading: boolean;
  error: Error | null;
  onSelect: (path: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const trimmed = query.trim();
  if (!trimmed) return null;

  if (isLoading) {
    return (
      <View style={styles.searchResults}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.searchResults}>
        <Text style={styles.errorText}>
          {withEmbeddingsConfigHint({
            error: toErrorMessage(error),
            hint: t("settings.hostSections.knowledgeBases.embeddings.configureHint"),
          })}
        </Text>
      </View>
    );
  }

  if (hits.length === 0) {
    return (
      <View style={styles.searchResults}>
        <Text style={styles.message}>
          {t("knowledgeBases.detail.searchEmpty", { query: trimmed })}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.searchResults} testID="kb-detail-search-results">
      {hits.map((hit) => (
        <SearchHitRow
          key={`${hit.path}:${hit.line ?? hit.score ?? hit.snippet}`}
          hit={hit}
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}

function TreePane({
  items,
  selectedPath,
  expandedDirs,
  onToggle,
  onSelect,
}: {
  items: KnowledgeBaseTreeItem[];
  selectedPath: string | null;
  expandedDirs: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): ReactElement {
  return (
    <ScrollView style={styles.treeScroll} testID="kb-detail-tree">
      {items.map((item) => (
        <TreeRow
          key={item.node.path}
          node={item.node}
          depth={item.depth}
          selected={selectedPath === item.node.path}
          expanded={expandedDirs.has(item.node.path)}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}

function NavBody({
  searchQuery,
  searchHits,
  searchLoading,
  searchError,
  treeLoading,
  treeError,
  visibleTree,
  selectedPath,
  expandedDirs,
  onSelectPage,
  onToggleDir,
  onRetryTree,
}: {
  searchQuery: string;
  searchHits: KnowledgeBaseSearchHit[];
  searchLoading: boolean;
  searchError: Error | null;
  treeLoading: boolean;
  treeError: Error | null;
  visibleTree: KnowledgeBaseTreeItem[];
  selectedPath: string | null;
  expandedDirs: Set<string>;
  onSelectPage: (path: string) => void;
  onToggleDir: (path: string) => void;
  onRetryTree: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (searchQuery.trim()) {
    return (
      <SearchResults
        query={searchQuery}
        hits={searchHits}
        isLoading={searchLoading}
        error={searchError}
        onSelect={onSelectPage}
      />
    );
  }

  if (treeLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }

  if (treeError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{toErrorMessage(treeError)}</Text>
        <Button size="sm" variant="secondary" onPress={onRetryTree}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  return (
    <TreePane
      items={visibleTree}
      selectedPath={selectedPath}
      expandedDirs={expandedDirs}
      onToggle={onToggleDir}
      onSelect={onSelectPage}
    />
  );
}

function PageToolbar({
  paneMode,
  dirty,
  busy,
  authoringReady,
  onEdit,
  onSave,
  onCancelEdit,
  onRename,
  onDeletePage,
}: {
  paneMode: KnowledgeBasePaneMode;
  dirty: boolean;
  busy: boolean;
  authoringReady: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onRename: () => void;
  onDeletePage: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (paneMode === "edit") {
    return (
      <View style={styles.pageToolbar} testID="kb-detail-edit-toolbar">
        <Button
          size="sm"
          onPress={onSave}
          loading={busy}
          disabled={busy || !dirty}
          testID="kb-detail-save-page"
        >
          {t("knowledgeBases.detail.save")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onPress={onCancelEdit}
          disabled={busy}
          testID="kb-detail-cancel-edit"
        >
          {t("common.actions.cancel")}
        </Button>
        {dirty ? (
          <Text style={styles.dirtyHint}>{t("knowledgeBases.detail.unsavedHint")}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.pageToolbar} testID="kb-detail-preview-toolbar">
      <Button
        size="sm"
        onPress={onEdit}
        disabled={busy || !authoringReady}
        testID="kb-detail-edit-page"
      >
        {t("knowledgeBases.detail.editPage")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onPress={onRename}
        disabled={busy || !authoringReady}
        testID="kb-detail-rename-page"
      >
        {t("knowledgeBases.detail.renamePage")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onPress={onDeletePage}
        disabled={busy || !authoringReady}
        testID="kb-detail-delete-page"
      >
        {t("knowledgeBases.detail.deletePage")}
      </Button>
    </View>
  );
}

function PreviewBody({
  selectedPath,
  isLoading,
  error,
  path,
  content,
  paneMode,
  draftContent,
  dirty,
  busy,
  authoringReady,
  onDraftChange,
  onEdit,
  onSave,
  onCancelEdit,
  onRename,
  onDeletePage,
}: {
  selectedPath: string | null;
  isLoading: boolean;
  error: Error | null;
  path: string | null;
  content: string | null;
  paneMode: KnowledgeBasePaneMode;
  draftContent: string;
  dirty: boolean;
  busy: boolean;
  authoringReady: boolean;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onRename: () => void;
  onDeletePage: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (!selectedPath) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("knowledgeBases.detail.selectPage")}</Text>
      </View>
    );
  }

  if (isLoading && paneMode !== "edit") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (error && paneMode !== "edit") {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{toErrorMessage(error)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.previewPaneInner}>
      <PageToolbar
        paneMode={paneMode}
        dirty={dirty}
        busy={busy}
        authoringReady={authoringReady}
        onEdit={onEdit}
        onSave={onSave}
        onCancelEdit={onCancelEdit}
        onRename={onRename}
        onDeletePage={onDeletePage}
      />
      {paneMode === "edit" ? (
        <ScrollView
          style={styles.previewScroll}
          contentContainerStyle={styles.previewContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.previewPath}>{path ?? selectedPath}</Text>
          <FormTextInput
            size="sm"
            value={draftContent}
            onChangeText={onDraftChange}
            editable={!busy}
            placeholder={t("knowledgeBases.detail.markdownPlaceholder")}
            style={styles.editorInput}
            multiline
            numberOfLines={20}
            textAlignVertical="top"
            testID="kb-detail-editor"
          />
        </ScrollView>
      ) : (
        <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewContent}>
          <Text style={styles.previewPath}>{path ?? selectedPath}</Text>
          <MarkdownRenderer text={content ?? ""} compact />
        </ScrollView>
      )}
    </View>
  );
}

function DetailOverflowMenu({
  kb,
  busy,
  onExport,
  onDelete,
}: {
  kb: KnowledgeBase;
  busy: boolean;
  onExport: () => void;
  onDelete: () => void;
}): ReactElement {
  const { t } = useTranslation();
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
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.hostSections.knowledgeBases.actionsMenu", {
          name: kb.name || kb.slug,
        })}
        testID="kb-detail-actions"
      >
        {({ hovered, open }) => (
          <ThemedMoreHorizontal
            size={ICON_SIZE.sm}
            uniProps={hovered || open ? foregroundColorMapping : mutedColorMapping}
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        <DropdownMenuItem leading={exportLeading} onSelect={onExport} testID="kb-detail-export">
          {t("settings.hostSections.knowledgeBases.export")}
        </DropdownMenuItem>
        <DropdownMenuItem
          destructive
          leading={deleteLeading}
          onSelect={onDelete}
          testID="kb-detail-delete"
        >
          {t("settings.hostSections.knowledgeBases.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DetailGateBody({
  kind,
  listError,
  onRetryList,
  onBack,
  serverId,
  knowledgeBaseId,
  usages,
  usagesLoading,
  mountedCount,
  authoringReady,
  authoringBusy,
  onAddFirstPage,
}: {
  kind: Exclude<DetailBodyKind, "browse">;
  listError: Error | null;
  onRetryList: () => void;
  onBack: () => void;
  serverId: string | null;
  knowledgeBaseId: string | null;
  usages: KnowledgeBaseUsage[];
  usagesLoading: boolean;
  mountedCount: number;
  authoringReady: boolean;
  authoringBusy: boolean;
  onAddFirstPage: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (kind === "noHost") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("knowledgeBases.noHost")}</Text>
      </View>
    );
  }

  if (kind === "unsupported") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("knowledgeBases.unsupported")}</Text>
      </View>
    );
  }

  if (kind === "loading") {
    if (listError) {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{toErrorMessage(listError)}</Text>
          <Button size="sm" variant="secondary" onPress={onRetryList}>
            {t("common.actions.retry")}
          </Button>
        </View>
      );
    }
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
        <Text style={styles.message}>{t("settings.hostSections.knowledgeBases.loading")}</Text>
      </View>
    );
  }

  if (kind === "notFound") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("knowledgeBases.detail.notFound")}</Text>
        <Button size="sm" variant="secondary" onPress={onBack}>
          {t("knowledgeBases.detail.backToList")}
        </Button>
      </View>
    );
  }

  if (kind === "browseUnavailable") {
    return (
      <View style={styles.mainColumn}>
        <UsagesPanel
          serverId={serverId}
          knowledgeBaseId={knowledgeBaseId}
          workspaces={usages}
          isLoading={usagesLoading}
          mountedCount={mountedCount}
        />
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
          <Text style={styles.message}>{t("knowledgeBases.detail.browseUnavailable")}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.mainColumn}>
      <UsagesPanel
        serverId={serverId}
        knowledgeBaseId={knowledgeBaseId}
        workspaces={usages}
        isLoading={usagesLoading}
        mountedCount={mountedCount}
      />
      <View style={styles.centered} testID="kb-detail-empty">
        <Text style={styles.emptyTitle}>{t("knowledgeBases.detail.emptyTitle")}</Text>
        <Text style={styles.message}>{t("knowledgeBases.detail.emptyBody")}</Text>
        {!authoringReady ? (
          <Text style={styles.message}>{t("knowledgeBases.detail.authoringUnavailable")}</Text>
        ) : null}
        <Button
          size="sm"
          leftIcon={Plus}
          disabled={!authoringReady || authoringBusy}
          onPress={onAddFirstPage}
          testID="kb-detail-add-first-page"
        >
          {t("knowledgeBases.detail.addFirstPage")}
        </Button>
      </View>
    </View>
  );
}

function DetailBrowseBody({
  isCompact,
  searchQuery,
  setSearchQuery,
  searchMode,
  setSearchMode,
  searchModeOptions,
  searchHits,
  searchLoading,
  searchError,
  treeLoading,
  treeError,
  visibleTree,
  selectedPath,
  expandedDirs,
  onSelectPage,
  onToggleDir,
  onRetryTree,
  onAddPage,
  authoringReady,
  authoringBusy,
  pageLoading,
  pageError,
  pagePath,
  pageContent,
  paneMode,
  draftContent,
  dirty,
  onDraftChange,
  onEdit,
  onSave,
  onCancelEdit,
  onRename,
  onDeletePage,
  serverId,
  knowledgeBaseId,
  usages,
  usagesLoading,
  mountedCount,
}: {
  isCompact: boolean;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  searchMode: KnowledgeBaseSearchMode;
  setSearchMode: (value: KnowledgeBaseSearchMode) => void;
  searchModeOptions: SegmentedControlOption<KnowledgeBaseSearchMode>[];
  searchHits: KnowledgeBaseSearchHit[];
  searchLoading: boolean;
  searchError: Error | null;
  treeLoading: boolean;
  treeError: Error | null;
  visibleTree: KnowledgeBaseTreeItem[];
  selectedPath: string | null;
  expandedDirs: Set<string>;
  onSelectPage: (path: string) => void;
  onToggleDir: (path: string) => void;
  onRetryTree: () => void;
  onAddPage: () => void;
  authoringReady: boolean;
  authoringBusy: boolean;
  pageLoading: boolean;
  pageError: Error | null;
  pagePath: string | null;
  pageContent: string | null;
  paneMode: KnowledgeBasePaneMode;
  draftContent: string;
  dirty: boolean;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onRename: () => void;
  onDeletePage: () => void;
  serverId: string | null;
  knowledgeBaseId: string | null;
  usages: KnowledgeBaseUsage[];
  usagesLoading: boolean;
  mountedCount: number;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={[styles.split, isCompact && styles.splitCompact]}>
      <View style={[styles.navPane, isCompact && styles.navPaneCompact]} testID="kb-detail-nav">
        <View style={styles.searchHeader}>
          <Button
            size="sm"
            leftIcon={Plus}
            onPress={onAddPage}
            disabled={!authoringReady || authoringBusy}
            testID="kb-detail-new-page"
          >
            {t("knowledgeBases.detail.newPage")}
          </Button>
          <FormTextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t("knowledgeBases.detail.searchPlaceholder")}
            size="sm"
            testID="kb-detail-search"
          />
          <SegmentedControl
            options={searchModeOptions}
            value={searchMode}
            onValueChange={setSearchMode}
            size="xs"
            testID="kb-detail-search-mode"
          />
        </View>
        <NavBody
          searchQuery={searchQuery}
          searchHits={searchHits}
          searchLoading={searchLoading}
          searchError={searchError}
          treeLoading={treeLoading}
          treeError={treeError}
          visibleTree={visibleTree}
          selectedPath={selectedPath}
          expandedDirs={expandedDirs}
          onSelectPage={onSelectPage}
          onToggleDir={onToggleDir}
          onRetryTree={onRetryTree}
        />
        <UsagesPanel
          serverId={serverId}
          knowledgeBaseId={knowledgeBaseId}
          workspaces={usages}
          isLoading={usagesLoading}
          mountedCount={mountedCount}
        />
      </View>
      <View style={styles.previewPane} testID="kb-detail-preview">
        <PreviewBody
          selectedPath={selectedPath}
          isLoading={pageLoading}
          error={pageError}
          path={pagePath}
          content={pageContent}
          paneMode={paneMode}
          draftContent={draftContent}
          dirty={dirty}
          busy={authoringBusy}
          authoringReady={authoringReady}
          onDraftChange={onDraftChange}
          onEdit={onEdit}
          onSave={onSave}
          onCancelEdit={onCancelEdit}
          onRename={onRename}
          onDeletePage={onDeletePage}
        />
      </View>
    </View>
  );
}

type DetailBodyKind =
  | "noHost"
  | "unsupported"
  | "loading"
  | "notFound"
  | "browseUnavailable"
  | "empty"
  | "browse";

function resolveDetailBodyKind(input: {
  hostCount: number;
  connected: boolean;
  supported: boolean;
  listLoading: boolean;
  hasKnowledgeBase: boolean;
  detailApisReady: boolean;
  treeLoading: boolean;
  treeEmpty: boolean;
}): DetailBodyKind {
  if (input.hostCount === 0) return "noHost";
  if (input.connected && !input.supported) return "unsupported";
  if (input.listLoading && !input.hasKnowledgeBase) return "loading";
  if (!input.hasKnowledgeBase) return "notFound";
  if (!input.detailApisReady) return "browseUnavailable";
  if (!input.treeLoading && input.treeEmpty) return "empty";
  return "browse";
}

function useSelectedHostId(hosts: HostProfile[]): [string, (serverId: string) => void] {
  const [selectedHost, setSelectedHost] = useState(() => hosts[0]?.serverId ?? "");

  useEffect(() => {
    if (hosts.length === 0) {
      setSelectedHost("");
      return;
    }
    if (!hosts.some((host) => host.serverId === selectedHost)) {
      setSelectedHost(hosts[0]?.serverId ?? "");
    }
  }, [hosts, selectedHost]);

  return [selectedHost, setSelectedHost];
}

function useKnowledgeBaseDetailMutations(options: {
  client: ReturnType<typeof useHostRuntimeClient>;
  knowledgeBase: KnowledgeBase | null;
  canPickPaths: boolean;
}): {
  busy: boolean;
  handleExport: () => void;
  handleDelete: () => void;
} {
  const { client, knowledgeBase, canPickPaths } = options;
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const handleExport = useCallback(() => {
    if (!knowledgeBase) return;
    if (!canPickPaths) {
      toast.show(
        t("settings.hostSections.knowledgeBases.exportCliHint", {
          slug: knowledgeBase.slug,
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
          idOrSlug: knowledgeBase.id,
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
  }, [canPickPaths, client, knowledgeBase, t, toast]);

  const handleDelete = useCallback(() => {
    if (!client || !knowledgeBase) return;
    void (async () => {
      setBusy(true);
      try {
        const usagesPayload = await client.knowledgeBaseListUsages({
          idOrSlug: knowledgeBase.id,
        });
        if (!usagesPayload.error && usagesPayload.workspaces.length > 0) {
          showDeleteBlockedAlert(knowledgeBase, usagesPayload.workspaces, t);
          return;
        }

        const confirmed = await confirmDialog({
          title: t("settings.hostSections.knowledgeBases.deleteTitle"),
          message: t("settings.hostSections.knowledgeBases.deleteMessage", {
            name: knowledgeBase.name || knowledgeBase.slug,
          }),
          confirmLabel: t("settings.hostSections.knowledgeBases.delete"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) return;

        const payload = await client.knowledgeBaseDelete({ idOrSlug: knowledgeBase.id });
        if (payload.code === "still_mounted") {
          showDeleteBlockedAlert(knowledgeBase, payload.workspaces ?? [], t);
          return;
        }
        if (payload.error || !payload.deleted) {
          toast.error(payload.error ?? t("settings.hostSections.knowledgeBases.deleteFailed"));
          return;
        }
        toast.show(t("settings.hostSections.knowledgeBases.deletedToast"), {
          variant: "success",
        });
        router.replace(buildKnowledgeBasesRoute());
      } catch (err) {
        toast.error(toErrorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [client, knowledgeBase, t, toast]);

  return { busy, handleExport, handleDelete };
}

export function KnowledgeBaseDetailScreen({ idOrSlug }: { idOrSlug: string }): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <KnowledgeBaseDetailScreenContent idOrSlug={idOrSlug} />;
}

function KnowledgeBaseDetailScreenContent({ idOrSlug }: { idOrSlug: string }): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useSelectedHostId(hosts);

  const serverId = selectedHost.trim().length > 0 ? selectedHost : null;
  const client = useHostRuntimeClient(selectedHost);
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const connected = connectionStatus === "online";
  const isLocalDaemon = useIsLocalDaemon(selectedHost);
  const canPickPaths = getIsElectron() && isLocalDaemon;

  const detailApis = useKnowledgeBaseDetailApis(client);
  const authoringApis = useKnowledgeBasePageAuthoringApis(client);
  const { knowledgeBase, supported, listLoading, listError, refetchList } = useKnowledgeBaseRecord(
    serverId,
    idOrSlug,
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<KnowledgeBaseSearchMode>("grep");

  const tree = useKnowledgeBaseTree({
    serverId,
    idOrSlug,
    listTree: detailApis.listTree,
  });
  const page = useKnowledgeBasePage({
    serverId,
    idOrSlug,
    path: selectedPath,
    getPage: detailApis.getPage,
  });
  const usages = useKnowledgeBaseUsages({ serverId, idOrSlug });
  const search = useKnowledgeBaseSearch({
    serverId,
    idOrSlug,
    query: searchQuery,
    mode: searchMode,
    search: detailApis.search,
  });

  const expandAncestors = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) {
        next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }, []);

  const applySelectedPath = useCallback(
    (path: string | null) => {
      setSelectedPath(path);
      if (path) {
        setSearchQuery("");
        expandAncestors(path);
      }
    },
    [expandAncestors],
  );

  const authoring = useKnowledgeBasePageAuthoring({
    idOrSlug: knowledgeBase?.id ?? idOrSlug,
    selectedPath,
    loadedContent: page.content,
    pageLoading: page.isLoading,
    upsertPage: authoringApis.upsertPage,
    deletePage: authoringApis.deletePage,
    authoringReady: authoringApis.ready,
    onSelectPath: applySelectedPath,
    onRefreshTree: tree.refetch,
    onRefreshPage: page.refetch,
  });

  const treeRoots = useMemo(() => buildKnowledgeBaseTree(tree.nodes), [tree.nodes]);
  const flatTree = useMemo(() => flattenKnowledgeBaseTree(treeRoots), [treeRoots]);
  const visibleTree = useMemo(
    () => filterVisibleKnowledgeBaseTree(flatTree, tree.nodes, expandedDirs),
    [expandedDirs, flatTree, tree.nodes],
  );

  useEffect(() => {
    if (tree.nodes.length === 0 || expandedDirs.size > 0) return;
    const roots = tree.nodes
      .filter((node) => node.kind === "directory" && node.parentPath === null)
      .map((node) => node.path);
    if (roots.length > 0) {
      setExpandedDirs(new Set(roots));
    }
  }, [expandedDirs.size, tree.nodes]);

  const title = knowledgeBase?.name?.trim() || knowledgeBase?.slug || idOrSlug;
  const mountedCount =
    usages.workspaces.length > 0
      ? usages.workspaces.length
      : (knowledgeBase?.mountedWorkspaceCount ?? 0);

  const searchModeOptions = useMemo<SegmentedControlOption<KnowledgeBaseSearchMode>[]>(
    () => [
      { value: "grep", label: t("knowledgeBases.detail.searchModeGrep") },
      { value: "vector", label: t("knowledgeBases.detail.searchModeVector") },
    ],
    [t],
  );

  const confirmLeaveIfDirty = authoring.confirmLeaveIfDirty;
  const openAddPage = authoring.openAddPage;

  const handleBack = useCallback(() => {
    void (async () => {
      if (!(await confirmLeaveIfDirty())) return;
      if (router.canGoBack()) {
        router.back();
        return;
      }
      router.replace(buildKnowledgeBasesRoute());
    })();
  }, [confirmLeaveIfDirty]);

  const handleToggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelectPage = useCallback(
    (path: string) => {
      void (async () => {
        if (path === selectedPath) return;
        if (!(await confirmLeaveIfDirty())) return;
        applySelectedPath(path);
      })();
    },
    [applySelectedPath, confirmLeaveIfDirty, selectedPath],
  );

  const handleAddPage = useCallback(() => {
    void (async () => {
      if (!(await confirmLeaveIfDirty())) return;
      openAddPage(false);
    })();
  }, [confirmLeaveIfDirty, openAddPage]);

  const handleAddFirstPage = useCallback(() => {
    openAddPage(true);
  }, [openAddPage]);

  const { busy, handleExport, handleDelete } = useKnowledgeBaseDetailMutations({
    client,
    knowledgeBase,
    canPickPaths,
  });

  const bodyKind = resolveDetailBodyKind({
    hostCount: hosts.length,
    connected,
    supported,
    listLoading,
    hasKnowledgeBase: Boolean(knowledgeBase),
    detailApisReady: detailApis.ready,
    treeLoading: tree.isLoading,
    treeEmpty: tree.nodes.length === 0,
  });

  const overflowBusy = busy || authoring.busy;
  const knowledgeBaseId = knowledgeBase?.id ?? null;
  const usagesProps = {
    serverId,
    knowledgeBaseId,
    usages: usages.workspaces,
    usagesLoading: usages.isLoading,
    mountedCount,
  };

  return (
    <KnowledgeBaseDetailChrome
      title={title}
      knowledgeBase={knowledgeBase}
      hosts={hosts}
      selectedHost={selectedHost}
      onSelectHost={setSelectedHost}
      overflowBusy={overflowBusy}
      onBack={handleBack}
      onExport={handleExport}
      onDelete={handleDelete}
      pathSheetVisible={authoring.pathSheetVisible}
      pathSheetMode={authoring.pathSheetMode}
      pathSubmitting={authoring.busy}
      pathDraft={authoring.pathDraft}
      contentDraft={authoring.contentDraft}
      pathFormError={authoring.pathFormError}
      showContentField={authoring.showContentField}
      onClosePathSheet={authoring.closePathSheet}
      onPathDraftChange={authoring.setPathDraft}
      onContentDraftChange={authoring.setContentDraft}
      onSubmitPathSheet={authoring.submitPathSheet}
    >
      {bodyKind === "browse" ? (
        <DetailBrowseBody
          isCompact={isCompact}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          searchMode={searchMode}
          setSearchMode={setSearchMode}
          searchModeOptions={searchModeOptions}
          searchHits={search.hits}
          searchLoading={search.isLoading}
          searchError={search.error}
          treeLoading={tree.isLoading}
          treeError={tree.error}
          visibleTree={visibleTree}
          selectedPath={selectedPath}
          expandedDirs={expandedDirs}
          onSelectPage={handleSelectPage}
          onToggleDir={handleToggleDir}
          onRetryTree={tree.refetch}
          onAddPage={handleAddPage}
          authoringReady={authoringApis.ready}
          authoringBusy={authoring.busy}
          pageLoading={page.isLoading}
          pageError={page.error}
          pagePath={page.path}
          pageContent={page.content}
          paneMode={authoring.paneMode}
          draftContent={authoring.draftContent}
          dirty={authoring.dirty}
          onDraftChange={authoring.setDraftContent}
          onEdit={authoring.enterEdit}
          onSave={authoring.saveEdit}
          onCancelEdit={authoring.cancelEdit}
          onRename={authoring.openRenamePage}
          onDeletePage={authoring.deleteSelectedPage}
          {...usagesProps}
        />
      ) : (
        <DetailGateBody
          kind={bodyKind}
          listError={listError}
          onRetryList={refetchList}
          onBack={handleBack}
          authoringReady={authoringApis.ready}
          authoringBusy={authoring.busy}
          onAddFirstPage={handleAddFirstPage}
          {...usagesProps}
        />
      )}
    </KnowledgeBaseDetailChrome>
  );
}

function KnowledgeBaseDetailChrome({
  title,
  knowledgeBase,
  hosts,
  selectedHost,
  onSelectHost,
  overflowBusy,
  onBack,
  onExport,
  onDelete,
  pathSheetVisible,
  pathSheetMode,
  pathSubmitting,
  pathDraft,
  contentDraft,
  pathFormError,
  showContentField,
  onClosePathSheet,
  onPathDraftChange,
  onContentDraftChange,
  onSubmitPathSheet,
  children,
}: {
  title: string;
  knowledgeBase: KnowledgeBase | null;
  hosts: HostProfile[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  overflowBusy: boolean;
  onBack: () => void;
  onExport: () => void;
  onDelete: () => void;
  pathSheetVisible: boolean;
  pathSheetMode: KnowledgeBasePagePathSheetMode;
  pathSubmitting: boolean;
  pathDraft: string;
  contentDraft: string;
  pathFormError: string | null;
  showContentField: boolean;
  onClosePathSheet: () => void;
  onPathDraftChange: (value: string) => void;
  onContentDraftChange: (value: string) => void;
  onSubmitPathSheet: () => void;
  children: ReactElement;
}): ReactElement {
  return (
    <View style={styles.container} testID="knowledge-base-detail-screen">
      <BackHeader title={title} onBack={onBack} />
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          {knowledgeBase ? (
            <Text style={styles.slugLine} numberOfLines={1}>
              {knowledgeBase.slug}
            </Text>
          ) : null}
          {hosts.length > 1 ? (
            <KnowledgeBaseHostPicker
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={onSelectHost}
            />
          ) : null}
        </View>
        {knowledgeBase ? (
          <DetailOverflowMenu
            kb={knowledgeBase}
            busy={overflowBusy}
            onExport={onExport}
            onDelete={onDelete}
          />
        ) : null}
      </View>
      {children}
      <KnowledgeBasePagePathSheet
        visible={pathSheetVisible}
        mode={pathSheetMode}
        submitting={pathSubmitting}
        path={pathDraft}
        content={contentDraft}
        formError={pathFormError}
        showContentField={showContentField}
        onClose={onClosePathSheet}
        onPathChange={onPathDraftChange}
        onContentChange={onContentDraftChange}
        onSubmit={onSubmitPathSheet}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[2],
  },
  toolbarLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  slugLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 1,
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
    maxWidth: 200,
  },
  hostName: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  mainColumn: {
    flex: 1,
  },
  split: {
    flex: 1,
    flexDirection: "row",
  },
  splitCompact: {
    flexDirection: "column",
  },
  navPane: {
    width: 300,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
    flexShrink: 0,
  },
  navPaneCompact: {
    width: "100%",
    maxHeight: "45%",
    borderRightWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  searchHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  treeScroll: {
    flex: 1,
  },
  treeRow: {
    minHeight: 32,
    justifyContent: "center",
  },
  treeRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  treeRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
  treeChevronSpacer: {
    width: 14,
  },
  treeLabel: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  treeLabelSelected: {
    fontWeight: "600",
  },
  previewPane: {
    flex: 1,
  },
  previewPaneInner: {
    flex: 1,
  },
  pageToolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  dirtyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  previewScroll: {
    flex: 1,
  },
  previewContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  previewPath: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  editorInput: {
    minHeight: 320,
    paddingTop: theme.spacing[2],
  },
  searchResults: {
    flex: 1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  searchHit: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  searchHitPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  searchHitSnippet: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  usagesPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  usagesSummary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  usagesHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[1],
  },
  usagesEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  usageRow: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
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
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
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
