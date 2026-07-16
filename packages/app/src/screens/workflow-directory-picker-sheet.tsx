// oxlint-disable react-perf/jsx-no-new-function-as-prop
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { ArrowUp, ChevronRight, Folder, FolderOpen, Search } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { isOpenableProjectPath } from "@/components/project-picker-options";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectField } from "@/components/ui/select-field";
import { isWeb } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { parentDirectoryPath } from "@/screens/workflow-directory-path";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";
import { shortenPath } from "@/utils/shorten-path";
import { toErrorMessage } from "@/utils/error-messages";

export interface WorkflowDirectoryShortcut {
  id: string;
  label: string;
  path: string;
}

interface WorkflowDirectoryPickerSheetProps {
  visible: boolean;
  serverId: string | null;
  initialPath: string | null;
  shortcuts?: readonly WorkflowDirectoryShortcut[];
  onClose: () => void;
  onSelect: (path: string) => void;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

const PICKER_SNAP_POINTS = ["80%"];
const PICKER_DESKTOP_HEIGHT = "80%" as const;
const SHOW_LOADING_DELAY_MS = 200;
const SEARCH_DEBOUNCE_MS = 250;
const EMPTY_SHORTCUTS: readonly WorkflowDirectoryShortcut[] = [];

function useDelayedFlag(active: boolean, delayMs = SHOW_LOADING_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    setShown(false);
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return shown;
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function rowStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, (hovered || pressed) && styles.rowActive];
}

function DirectoryBrowserCard({
  parentPath,
  directories,
  showLoading,
  isRefreshing,
  errorMessage,
  emptyText,
  upLabel,
  onGoUp,
  onOpenChild,
}: {
  parentPath: string | null;
  directories: readonly DirectoryEntry[];
  showLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
  emptyText: string;
  upLabel: string;
  onGoUp: () => void;
  onOpenChild: (name: string) => void;
}): ReactElement {
  const cardStyle = isRefreshing ? styles.browserCardRefreshing : styles.browserCard;
  return (
    <View style={cardStyle}>
      {parentPath ? (
        <Pressable style={rowStyle} onPress={onGoUp} testID="workflow-directory-picker-up">
          <ArrowUp size={16} color={styles.icon.color} />
          <Text style={styles.rowTitle}>{upLabel}</Text>
        </Pressable>
      ) : null}
      <ScrollView
        style={styles.browserScroll}
        contentContainerStyle={styles.browserScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {showLoading ? (
          <View style={styles.centered}>
            <LoadingSpinner size="small" color={styles.spinner.color} />
          </View>
        ) : null}
        {errorMessage && !showLoading ? <Text style={styles.error}>{errorMessage}</Text> : null}
        {!showLoading && !errorMessage && directories.length === 0 ? (
          <Text style={styles.meta}>{emptyText}</Text>
        ) : null}
        {!showLoading
          ? directories.map((entry) => (
              <Pressable
                key={entry.path}
                style={rowStyle}
                onPress={() => onOpenChild(entry.name)}
                testID={`workflow-directory-entry-${entry.name}`}
              >
                <Folder size={16} color={styles.icon.color} />
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {entry.name}
                </Text>
                <ChevronRight size={14} color={styles.icon.color} />
              </Pressable>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

function DirectorySearchResults({
  paths,
  isSearching,
  emptyText,
  searchingText,
  onSelect,
}: {
  paths: readonly string[];
  isSearching: boolean;
  emptyText: string;
  searchingText: string;
  onSelect: (path: string) => void;
}): ReactElement {
  return (
    <View style={styles.browserCard}>
      <ScrollView
        style={styles.browserScroll}
        contentContainerStyle={styles.browserScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {isSearching ? <Text style={styles.meta}>{searchingText}</Text> : null}
        {!isSearching && paths.length === 0 ? <Text style={styles.meta}>{emptyText}</Text> : null}
        {!isSearching
          ? paths.map((path) => (
              <Pressable
                key={path}
                style={rowStyle}
                onPress={() => onSelect(path)}
                testID={`workflow-directory-search-${path}`}
              >
                <Folder size={16} color={styles.icon.color} />
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {shortenPath(path)}
                </Text>
              </Pressable>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

function ShortcutSelect({
  shortcuts,
  currentPath,
  onSelect,
}: {
  shortcuts: readonly WorkflowDirectoryShortcut[];
  currentPath: string;
  onSelect: (path: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      shortcuts.map((shortcut) => ({
        id: shortcut.id,
        value: shortcut.path,
        label: shortcut.label,
        description: shortenPath(shortcut.path),
        kind: "directory" as const,
        testID: `workflow-directory-shortcut-${shortcut.id}`,
      })),
    [shortcuts],
  );
  const selected = options.find((option) => option.value === currentPath) ?? null;
  const selectedDisplay = useMemo(
    () => (selected ? { label: selected.label, description: selected.description } : null),
    [selected],
  );
  const leading = useMemo(() => <Folder size={16} color={styles.icon.color} />, []);
  const handleChange = useCallback(
    (path: string) => {
      onSelect(path);
    },
    [onSelect],
  );

  if (shortcuts.length === 0) {
    return null;
  }

  return (
    <SelectField
      label={t("workflows.directoryPickerShortcuts")}
      value={selected?.value ?? null}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleChange}
      placeholder={t("workflows.directoryPickerShortcutsPlaceholder")}
      emptyText={t("workflows.directoryPickerShortcutsEmpty")}
      searchable
      searchPlaceholder={t("workflows.directoryPickerShortcutsSearch")}
      title={t("workflows.directoryPickerShortcuts")}
      size="sm"
      triggerLeading={leading}
      triggerTestID="workflow-directory-shortcuts-trigger"
    />
  );
}

function DirectoryBrowsePane({
  shortcuts,
  currentPath,
  parentPath,
  directories,
  showLoading,
  isRefreshing,
  errorMessage,
  onSelectShortcut,
  onGoUp,
  onOpenChild,
}: {
  shortcuts: readonly WorkflowDirectoryShortcut[];
  currentPath: string;
  parentPath: string | null;
  directories: readonly DirectoryEntry[];
  showLoading: boolean;
  isRefreshing: boolean;
  errorMessage: string | null;
  onSelectShortcut: (path: string) => void;
  onGoUp: () => void;
  onOpenChild: (name: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <ShortcutSelect shortcuts={shortcuts} currentPath={currentPath} onSelect={onSelectShortcut} />
      <View style={styles.browserSection}>
        <Text style={styles.sectionLabel}>{t("workflows.directoryPickerBrowse")}</Text>
        <DirectoryBrowserCard
          parentPath={parentPath}
          directories={directories}
          showLoading={showLoading}
          isRefreshing={isRefreshing}
          errorMessage={errorMessage}
          emptyText={t("workflows.directoryPickerEmpty")}
          upLabel={t("workflows.directoryPickerUp")}
          onGoUp={onGoUp}
          onOpenChild={onOpenChild}
        />
      </View>
    </>
  );
}

function useDirectoryListing(args: {
  visible: boolean;
  serverId: string | null;
  currentPath: string;
  enabled: boolean;
  clientUnavailableMessage: string;
}) {
  const client = useHostRuntimeClient(args.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(args.serverId ?? "");
  const [retainedDirectories, setRetainedDirectories] = useState<DirectoryEntry[]>([]);

  const listingQuery = useFetchQuery({
    queryKey: ["workflow-directory-picker", args.serverId, args.currentPath],
    queryFn: async () => {
      if (!client) {
        throw new Error(args.clientUnavailableMessage);
      }
      return client.listDirectory(args.currentPath, ".");
    },
    enabled: Boolean(
      args.visible && client && isConnected && args.currentPath.trim() && args.enabled,
    ),
    retry: false,
    dataShape: "value",
    staleTimeMs: 8_000,
  });

  const freshDirectories = useMemo(
    () =>
      (listingQuery.data?.entries ?? [])
        .filter((entry) => entry.kind === "directory")
        .map((entry) => ({ name: entry.name, path: entry.path })),
    [listingQuery.data?.entries],
  );

  useEffect(() => {
    if (freshDirectories.length > 0 || !listingQuery.isFetching) {
      setRetainedDirectories(freshDirectories);
    }
  }, [freshDirectories, listingQuery.isFetching]);

  const directories =
    freshDirectories.length > 0 || !listingQuery.isFetching
      ? freshDirectories
      : retainedDirectories;

  return {
    directories,
    isFetching: listingQuery.isFetching,
    isPending: listingQuery.isPending,
    errorMessage: listingQuery.isError ? toErrorMessage(listingQuery.error) || null : null,
  };
}

function useDirectorySearch(args: {
  visible: boolean;
  serverId: string | null;
  query: string;
  shortcuts: readonly WorkflowDirectoryShortcut[];
}) {
  const client = useHostRuntimeClient(args.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(args.serverId ?? "");
  const hasQuery = args.query.trim().length > 0;
  const debouncedQuery = useDebouncedValue(args.query, SEARCH_DEBOUNCE_MS);

  const suggestionsQuery = useFetchQuery({
    queryKey: ["workflow-directory-suggestions", args.serverId, debouncedQuery],
    queryFn: async () => {
      if (!client) {
        return { query: debouncedQuery, paths: [] as string[] };
      }
      const result = await client.getDirectorySuggestions({
        query: debouncedQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return {
        query: debouncedQuery,
        paths:
          result.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ??
          [],
      };
    },
    enabled: Boolean(args.visible && client && isConnected && hasQuery),
    retry: false,
    dataShape: "value",
    staleTimeMs: 15_000,
  });

  const paths = useMemo(() => {
    if (!hasQuery) {
      return [];
    }
    const serverPaths =
      suggestionsQuery.data?.query === debouncedQuery ? (suggestionsQuery.data.paths ?? []) : [];
    const recommendedPaths = args.shortcuts.map((shortcut) => shortcut.path);
    const suggested = buildWorkingDirectorySuggestions({
      recommendedPaths,
      serverPaths,
      query: args.query,
    });
    const trimmed = args.query.trim();
    if (isOpenableProjectPath(trimmed) && !suggested.includes(trimmed)) {
      return [trimmed, ...suggested];
    }
    return suggested;
  }, [args.query, args.shortcuts, debouncedQuery, hasQuery, suggestionsQuery.data]);

  const isSearching =
    hasQuery &&
    paths.length === 0 &&
    (args.query !== debouncedQuery || suggestionsQuery.isFetching);

  return { hasQuery, paths, isSearching };
}

export function WorkflowDirectoryPickerSheet({
  visible,
  serverId,
  initialPath,
  shortcuts = EMPTY_SHORTCUTS,
  onClose,
  onSelect,
}: WorkflowDirectoryPickerSheetProps): ReactElement {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState("~");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!visible) {
      return;
    }
    const seed =
      initialPath?.trim() || shortcuts.find((item) => item.path.trim())?.path.trim() || "~";
    setCurrentPath(seed);
    setQuery("");
  }, [initialPath, shortcuts, visible]);

  const search = useDirectorySearch({ visible, serverId, query, shortcuts });
  const listing = useDirectoryListing({
    visible,
    serverId,
    currentPath,
    enabled: !search.hasQuery,
    clientUnavailableMessage: t("common.errors.daemonClientUnavailable"),
  });

  const parentPath = useMemo(() => parentDirectoryPath(currentPath), [currentPath]);
  const showLoading = useDelayedFlag(listing.isPending && listing.directories.length === 0);
  const resolvedError =
    listing.errorMessage === null
      ? null
      : listing.errorMessage || t("workflows.directoryPickerError");

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("workflows.directoryPickerTitle"),
      subtitle: (
        <Text style={styles.pathSubtitle} numberOfLines={1}>
          {shortenPath(currentPath)}
        </Text>
      ),
    }),
    [currentPath, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          variant="default"
          leftIcon={FolderOpen}
          testID="workflow-directory-picker-select"
          onPress={() => onSelect(currentPath)}
        >
          {t("workflows.directoryPickerSelect")}
        </Button>
      </View>
    ),
    [currentPath, onSelect, t],
  );

  const openChild = useCallback((entryName: string) => {
    setCurrentPath((prev) =>
      buildAbsoluteExplorerPath({
        workspaceRoot: prev,
        entryPath: entryName,
      }),
    );
  }, []);

  const jumpToPath = useCallback((path: string) => {
    setCurrentPath(path);
    setQuery("");
  }, []);

  const goUp = useCallback(() => {
    if (parentPath) setCurrentPath(parentPath);
  }, [parentPath]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      snapPoints={PICKER_SNAP_POINTS}
      desktopHeight={PICKER_DESKTOP_HEIGHT}
      scrollable={false}
      presentation="push"
      testID="workflow-directory-picker-sheet"
    >
      <View style={styles.body}>
        <View style={styles.searchRow}>
          <Search size={16} color={styles.icon.color} />
          <AdaptiveTextInput
            value={query}
            initialValue={query}
            onChangeText={setQuery}
            placeholder={t("workflows.directoryPickerSearchPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            // @ts-expect-error - outlineStyle is web-only
            style={SEARCH_INPUT_STYLE}
            testID="workflow-directory-search"
          />
        </View>

        {search.hasQuery ? (
          <View style={styles.browserSection}>
            <Text style={styles.sectionLabel}>{t("workflows.directoryPickerSearchResults")}</Text>
            <DirectorySearchResults
              paths={search.paths}
              isSearching={search.isSearching}
              emptyText={t("workflows.directoryPickerNoMatches")}
              searchingText={t("workflows.directoryPickerSearching")}
              onSelect={jumpToPath}
            />
          </View>
        ) : (
          <DirectoryBrowsePane
            shortcuts={shortcuts}
            currentPath={currentPath}
            parentPath={parentPath}
            directories={listing.directories}
            showLoading={showLoading}
            isRefreshing={listing.isFetching && !showLoading}
            errorMessage={resolvedError}
            onSelectShortcut={setCurrentPath}
            onGoUp={goUp}
            onOpenChild={openChild}
          />
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  body: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[4],
    userSelect: "none",
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    userSelect: "text",
  },
  browserSection: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  pathSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  browserCard: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  browserCardRefreshing: {
    flex: 1,
    minHeight: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
    opacity: 0.72,
  },
  browserScroll: {
    flex: 1,
    minHeight: 0,
  },
  browserScrollContent: {
    flexGrow: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    userSelect: "none",
  },
  rowActive: {
    backgroundColor: theme.colors.surface1,
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    userSelect: "none",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[6],
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));

const SEARCH_INPUT_STYLE = [styles.searchInput, isWeb && { outlineStyle: "none" }];
