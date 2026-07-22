import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Archive, Plug, Plus, RotateCw, SquareKanban } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  KANBAN_STATUS_ORDER,
  type KanbanColumn,
  type KanbanSourceKind,
  type StoredKanbanCard,
  type StoredKanbanSource,
} from "@getpaseo/protocol/kanban/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { KanbanBoard, resolveCardColumn } from "@/components/kanban/kanban-board";
import { KanbanCardSheet } from "@/components/kanban/kanban-card-sheet";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { KanbanHiddenColumnsSheet } from "@/components/kanban/kanban-hidden-columns-sheet";
import { resolveKanbanSourceView } from "@/components/kanban/kanban-source-view-registry";
import {
  buildKanbanBoardTabs,
  selectCardsForSource,
  selectKanbanTabCards,
  type KanbanBoardTab,
} from "@/kanban/board-tabs";
import { KanbanSourceFormSheet } from "@/components/kanban/kanban-source-form-sheet";
import { KanbanSourcesSheet } from "@/components/kanban/kanban-sources-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useKanbanCards } from "@/hooks/use-kanban-cards";
import { useKanbanColumnMutations } from "@/hooks/use-kanban-column-mutations";
import { useKanbanColumns } from "@/hooks/use-kanban-columns";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { useKanbanSources } from "@/hooks/use-kanban-sources";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { formatTimeAgo } from "@/utils/time";

type SourceFormState = { mode: "create" } | { mode: "edit"; source: StoredKanbanSource } | null;

// Multi-tab kanban (docs/kanban.md roadmap, 2026-07-18 product spec):
// "overview" is aggregate-only — per-source summary + focus row, NO board
// underneath (that's what the source/manual tabs are for). One tab per
// CONFIGURED SOURCE so two queues of the same kind (a GitLab review queue and
// an authored-MR board) count separately; see buildKanbanBoardTabs for the tab
// set and the orphan tab that keeps a deleted source's cards reachable.
// "manual" is always present (fixed last) so there's always a place to add +
// see hand-created cards, and gets the original full-board experience (global
// columns, drag, long-press, detail) via the generic KanbanBoard directly — it
// has no source kind, so it never goes through the source-view registry.
// A card counts as stale for the Overview focus row once it's sat this long
// without an update and isn't in a terminal column.
const STALE_CARD_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_LEGACY_STATUSES: ReadonlySet<string> = new Set(["done", "skip", "fail", "abort"]);

interface KanbanBoardColumns {
  visibleColumns: KanbanColumn[];
  hiddenColumns: KanbanColumn[];
}

// Old daemons without the columns capability get six fixed pseudo-columns, one
// per KanbanStatus, so the board renders the same six lanes it always has.
// `id` equals the status name so card grouping and drag hit-testing fall back
// to the same identity cards already carry.
function useKanbanBoardColumns(
  serverId: string | null,
  active: boolean,
  kanbanColumnsSupported: boolean,
): KanbanBoardColumns {
  const { t } = useTranslation();
  const { columns: fetchedColumns } = useKanbanColumns(
    active && kanbanColumnsSupported ? serverId : null,
  );
  const fallbackColumns = useMemo<KanbanColumn[]>(
    () =>
      KANBAN_STATUS_ORDER.map((status, index) => ({
        id: status,
        title: t(`kanban.columns.${status}`),
        order: index,
        hidden: false,
        legacyStatus: status,
      })),
    [t],
  );
  const allColumns = kanbanColumnsSupported ? fetchedColumns : fallbackColumns;
  const visibleColumns = useMemo(
    () => allColumns.filter((column) => !column.hidden).sort((a, b) => a.order - b.order),
    [allColumns],
  );
  const hiddenColumns = useMemo(() => allColumns.filter((column) => column.hidden), [allColumns]);
  return { visibleColumns, hiddenColumns };
}

export function KanbanScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <KanbanScreenContent />;
}

function KanbanScreenContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  // Single active host for v1 (no multi-host aggregation). The first host is the
  // board's scope; capability detection happens once against it.
  const serverId = hosts[0]?.serverId ?? null;
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (connectionStatuses.get(serverId) ?? "connecting") : null;
  const isOnline = connectionStatus === "online";
  // Still settling (not yet online, not failed) → show a spinner rather than a
  // false offline/empty state. A truly offline/disconnected host falls through.
  const isConnecting = connectionStatus === "connecting" || connectionStatus === "idle";
  const kanbanSupported = useHostFeature(serverId, "kanban");
  // Column capability detection lives here, alongside the base "kanban"
  // capability check above — a single place downstream code reads from.
  const kanbanColumnsSupported = useHostFeature(serverId, "kanbanColumns");
  const kanbanCardDetailSupported = useHostFeature(serverId, "kanbanCardDetail");

  const active = Boolean(serverId && isOnline && kanbanSupported);
  const { cards, isLoading, isError, refetch } = useKanbanCards(active ? serverId : null);
  const { sources } = useKanbanSources(active ? serverId : null);
  const mutations = useKanbanMutations({ serverId: serverId ?? "" });
  const columnMutations = useKanbanColumnMutations({ serverId: serverId ?? "" });
  const { visibleColumns, hiddenColumns } = useKanbanBoardColumns(
    serverId,
    active,
    kanbanColumnsSupported,
  );

  const tabs = useMemo(() => buildKanbanBoardTabs({ sources, cards }), [sources, cards]);

  // Keyed by tab key, not by object identity: the tab list is rebuilt on every
  // card/source change, so holding the descriptor itself would reset the
  // selection constantly. A tab that disappears (its source was deleted) falls
  // back to Overview.
  const [activeTabKey, setActiveTabKey] = useState<string>("overview");
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeTabKey) ?? tabs[0],
    [tabs, activeTabKey],
  );
  useEffect(() => {
    if (!tabs.some((tab) => tab.key === activeTabKey)) {
      setActiveTabKey("overview");
    }
  }, [tabs, activeTabKey]);

  const tabCards = useMemo(
    () => selectKanbanTabCards({ tab: activeTab, cards, sources }),
    [activeTab, cards, sources],
  );
  const SourceView = useMemo(() => {
    if (activeTab.type === "manual") {
      return KanbanBoard;
    }
    return resolveKanbanSourceView(activeTab.kind);
  }, [activeTab]);

  const [hiddenColumnsOpen, setHiddenColumnsOpen] = useState(false);
  const openHiddenColumns = useCallback(() => setHiddenColumnsOpen(true), []);
  const closeHiddenColumns = useCallback(() => setHiddenColumnsOpen(false), []);
  const handleRestoreColumn = useCallback(
    (columnId: string) => {
      void columnMutations.updateColumn({ id: columnId, hidden: false });
    },
    [columnMutations],
  );

  const [createOpen, setCreateOpen] = useState(false);
  // Bump on each open so the create sheet remounts with empty fields.
  const [createNonce, setCreateNonce] = useState(0);
  const openCreate = useCallback(() => {
    setCreateNonce((nonce) => nonce + 1);
    setCreateOpen(true);
  }, []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);

  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceForm, setSourceForm] = useState<SourceFormState>(null);
  // Bump so the form remounts with fresh field state on each open.
  const [sourceFormNonce, setSourceFormNonce] = useState(0);
  const openSources = useCallback(() => setSourcesOpen(true), []);
  const closeSources = useCallback(() => setSourcesOpen(false), []);

  const toast = useToast();
  const handleSync = useCallback(() => {
    // Per-source failures are also recorded server-side and shown per-row in
    // the sources sheet, but this summary is the one visible feedback the
    // board-level Sync button gives without opening that sheet.
    void mutations
      .syncSources()
      .then((summary) => {
        const failed = summary.results.filter((result) => !result.ok);
        if (failed.length === 0) {
          if (summary.results.length > 0) {
            toast.show(t("kanban.sync.succeeded", { count: summary.results.length }), {
              variant: "success",
            });
          }
          return undefined;
        }
        const names = failed.map((result) => result.name).join(", ");
        toast.show(
          <Pressable onPress={openSources} accessibilityRole="button">
            <Text style={styles.syncFailedToastText}>
              {t("kanban.sync.failed", { count: failed.length, names })}
            </Text>
          </Pressable>,
          { variant: "error", durationMs: 5000, testID: "kanban-sync-failed-toast" },
        );
        return undefined;
      })
      .catch(() => undefined);
  }, [mutations, openSources, t, toast]);
  const openAddSource = useCallback(() => {
    setSourceFormNonce((nonce) => nonce + 1);
    setSourceForm({ mode: "create" });
  }, []);
  const openEditSource = useCallback((source: StoredKanbanSource) => {
    setSourceFormNonce((nonce) => nonce + 1);
    setSourceForm({ mode: "edit", source });
  }, []);
  const closeSourceForm = useCallback(() => setSourceForm(null), []);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("kanban.title")} />
      <KanbanScreenBody
        serverId={serverId}
        isOnline={isOnline}
        isConnecting={isConnecting}
        kanbanSupported={kanbanSupported}
        kanbanColumnsSupported={kanbanColumnsSupported}
        kanbanCardDetailSupported={kanbanCardDetailSupported}
        hasAnyCards={cards.length > 0}
        allCards={cards}
        cards={tabCards}
        columns={visibleColumns}
        hiddenColumnsCount={hiddenColumns.length}
        isLoading={isLoading}
        isError={isError}
        onRetry={refetch}
        onCreate={openCreate}
        onSync={handleSync}
        onManageSources={openSources}
        onManageHiddenColumns={openHiddenColumns}
        isSyncing={mutations.isSyncing}
        mutations={mutations}
        columnMutations={columnMutations}
        sources={sources}
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTabKey}
        SourceView={SourceView}
      />
      <KanbanCardSheet
        key={`create:${createNonce}`}
        visible={createOpen}
        mode="create"
        onClose={closeCreate}
        onCreate={mutations.createCard}
        onUpdate={mutations.updateCard}
        onDelete={mutations.deleteCard}
      />
      {serverId ? (
        <>
          <KanbanSourcesSheet
            serverId={serverId}
            visible={sourcesOpen}
            onClose={closeSources}
            onAddSource={openAddSource}
            onEditSource={openEditSource}
          />
          <KanbanSourceFormSheet
            key={`source-form:${sourceFormNonce}`}
            serverId={serverId}
            visible={sourceForm !== null}
            mode={sourceForm?.mode === "edit" ? "edit" : "create"}
            source={sourceForm?.mode === "edit" ? sourceForm.source : undefined}
            onClose={closeSourceForm}
          />
        </>
      ) : null}
      {kanbanColumnsSupported ? (
        <KanbanHiddenColumnsSheet
          visible={hiddenColumnsOpen}
          columns={hiddenColumns}
          onClose={closeHiddenColumns}
          onRestore={handleRestoreColumn}
        />
      ) : null}
    </View>
  );
}

interface KanbanScreenBodyProps {
  serverId: string | null;
  isOnline: boolean;
  isConnecting: boolean;
  kanbanSupported: boolean;
  kanbanColumnsSupported: boolean;
  kanbanCardDetailSupported: boolean;
  // Whether the board has any cards at all (unscoped by tab) — only used to
  // decide the load-error fallback below, never the per-tab empty states.
  hasAnyCards: boolean;
  // Full, unscoped card list — only for the Overview per-source summary rows.
  allCards: StoredKanbanCard[];
  cards: ReturnType<typeof useKanbanCards>["cards"];
  columns: KanbanColumn[];
  hiddenColumnsCount: number;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onSync: () => void;
  onManageSources: () => void;
  onManageHiddenColumns: () => void;
  isSyncing: boolean;
  mutations: ReturnType<typeof useKanbanMutations>;
  columnMutations: ReturnType<typeof useKanbanColumnMutations>;
  sources: StoredKanbanSource[];
  tabs: KanbanBoardTab[];
  activeTab: KanbanBoardTab;
  onTabChange: (tabKey: string) => void;
  SourceView: ReturnType<typeof resolveKanbanSourceView>;
}

function KanbanScreenBody({
  serverId,
  isOnline,
  isConnecting,
  kanbanSupported,
  kanbanColumnsSupported,
  kanbanCardDetailSupported,
  hasAnyCards,
  allCards,
  cards,
  columns,
  hiddenColumnsCount,
  isLoading,
  isError,
  onRetry,
  onCreate,
  onSync,
  onManageSources,
  onManageHiddenColumns,
  isSyncing,
  mutations,
  columnMutations,
  sources,
  tabs,
  activeTab,
  onTabChange,
  SourceView,
}: KanbanScreenBodyProps): ReactElement {
  const { t } = useTranslation();

  // Host reachable but without the capability → single, localized upgrade prompt.
  if (serverId && isOnline && !kanbanSupported) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message} testID="kanban-unsupported">
          {t("kanban.unsupported")}
        </Text>
      </View>
    );
  }

  // Spinner only while actively loading cards or while the host is still
  // settling — never when disconnected/offline (that falls through to empty).
  if (isLoading || isConnecting) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (isError && !hasAnyCards) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("kanban.loadError")}</Text>
        <Button variant="ghost" onPress={onRetry} testID="kanban-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      {tabs.length > 1 ? (
        <View style={styles.tabsRow}>
          <KanbanTabs
            tabs={tabs}
            activeTab={activeTab}
            sources={sources}
            onTabChange={onTabChange}
          />
        </View>
      ) : null}
      <View style={styles.actionsRow}>
        {activeTab.type === "manual" ? (
          <Button
            variant="outline"
            leftIcon={Plus}
            onPress={onCreate}
            size="sm"
            testID="kanban-add"
          >
            {t("kanban.actions.add")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          leftIcon={RotateCw}
          onPress={onSync}
          size="sm"
          loading={isSyncing}
          testID="kanban-sync"
        >
          {t("kanban.actions.sync")}
        </Button>
        <Button
          variant="ghost"
          leftIcon={Plug}
          onPress={onManageSources}
          size="sm"
          testID="kanban-sources"
        >
          {t("kanban.actions.sources")}
        </Button>
        {kanbanColumnsSupported && hiddenColumnsCount > 0 ? (
          <Button
            variant="ghost"
            leftIcon={Archive}
            onPress={onManageHiddenColumns}
            size="sm"
            testID="kanban-hidden-columns"
          >
            {t("kanban.hiddenColumns.entry")}
          </Button>
        ) : null}
      </View>
      {activeTab.type === "overview" ? (
        // Overview is aggregate-only — summary rows + focus row, no board
        // underneath (that's what the source/manual tabs are for).
        <KanbanOverviewSummaries
          sources={sources}
          cards={allCards}
          columns={columns}
          onSelectSource={onTabChange}
        />
      ) : (
        <KanbanBoardArea
          cards={cards}
          columns={columns}
          columnsSupported={kanbanColumnsSupported}
          serverId={serverId}
          cardDetailSupported={kanbanCardDetailSupported}
          mutations={mutations}
          columnMutations={columnMutations}
          sources={sources}
          onCreate={onCreate}
          showAddCta={activeTab.type === "manual"}
          SourceView={SourceView}
        />
      )}
    </View>
  );
}

// Overview + one tab per configured source. A source list can grow past a
// SegmentedControl's fixed-width row, so this scrolls horizontally instead —
// each tab is a themed Button (existing component, no new visual system),
// icon-tagged with the same glyph the card uses for that source's kind.
// Overview + one segment per configured source + Manual. A plain component
// (not inlined) so KanbanScreenBody's early-return branches above don't have
// to carry SegmentedControl's generic type through.
//
// A source tab is labelled with the source's own name — that is what tells two
// GitLab queues apart. Orphan tabs (a deleted source's leftover cards) fall
// back to the kind label, which reads as the catch-all it is.
function resolveTabLabel(tab: KanbanBoardTab, sources: StoredKanbanSource[], t: TFunction): string {
  switch (tab.type) {
    case "overview":
      return t("kanban.tabs.overview");
    case "manual":
      return t("kanban.filters.source.manual");
    case "orphan":
      return t(`kanban.filters.source.${tab.kind}`);
    case "source":
      return (
        sources.find((source) => source.id === tab.sourceId)?.name.trim() ||
        t(`kanban.filters.source.${tab.kind}`)
      );
  }
}

function KanbanTabs({
  tabs,
  activeTab,
  sources,
  onTabChange,
}: {
  tabs: KanbanBoardTab[];
  activeTab: KanbanBoardTab;
  sources: StoredKanbanSource[];
  onTabChange: (tabKey: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<string>[]>(
    () =>
      tabs.map((tab) => ({
        value: tab.key,
        label: resolveTabLabel(tab, sources, t),
        testID: `kanban-tab-${tab.key}`,
      })),
    [tabs, sources, t],
  );
  return (
    <SegmentedControl
      size="sm"
      value={activeTab.key}
      onValueChange={onTabChange}
      options={options}
      testID="kanban-tabs"
    />
  );
}

// The kind glyph mirrors the card header icon (kanban-card-theme) — GitLab
// sources use the "gitlab-mr" theme key, everything else (jira today) maps
// 1:1 to its own theme key.
function kanbanSourceKindIcon(kind: KanbanSourceKind) {
  return resolveKanbanCardTheme(kind === "gitlab" ? "gitlab-mr" : kind).icon;
}

// Overview: one read-only summary card per CONFIGURED SOURCE (name, kind
// icon, per-column card counts scoped by kind — see the known-limitation note
// last-sync time, lastSyncError indicator) — clicking one jumps to that
// source's own tab. Plus a lightweight focus row (unresolved
// discussion count, stale-card count). Full board stays underneath, unchanged.
function KanbanOverviewSummaries({
  sources,
  cards,
  columns,
  onSelectSource,
}: {
  sources: StoredKanbanSource[];
  cards: StoredKanbanCard[];
  columns: KanbanColumn[];
  onSelectSource: (tabKey: string) => void;
}): ReactElement {
  return (
    <View style={styles.overviewSection} testID="kanban-overview-summaries">
      <View style={styles.overviewSummaryList}>
        {sources.map((source) => (
          <KanbanOverviewSourceRow
            key={source.id}
            source={source}
            cards={cards}
            columns={columns}
            onSelect={onSelectSource}
          />
        ))}
      </View>
      <KanbanOverviewFocusRow cards={cards} columns={columns} />
    </View>
  );
}

// Same three-way sync-status text as the sources sheet (error > last sync
// time > never synced) — mirrors resolveSyncStatusLabel in
// kanban-sources-sheet.tsx so the two surfaces never say different things.
function resolveOverviewSyncStatus(source: StoredKanbanSource, t: TFunction): string {
  if (source.lastSyncError) {
    return t("kanban.sources.syncFailed", { error: source.lastSyncError });
  }
  if (source.lastSyncAt) {
    return t("kanban.sources.lastSync", { time: formatTimeAgo(new Date(source.lastSyncAt)) });
  }
  return t("kanban.sources.neverSynced");
}

function KanbanOverviewSourceRow({
  source,
  cards,
  columns,
  onSelect,
}: {
  source: StoredKanbanSource;
  cards: StoredKanbanCard[];
  columns: KanbanColumn[];
  onSelect: (tabKey: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(source.id), [onSelect, source.id]);
  // Scoped to the cards THIS source's query backs, so two sources of the same
  // kind report their own numbers. A card matched by both is counted by both —
  // it is one piece of work sitting in two queues, not two cards.
  const columnCounts = useMemo(() => {
    const sourceCards = selectCardsForSource(cards, source.id);
    return columns
      .map((column) => ({
        column,
        count: sourceCards.filter((card) => resolveCardColumn(card, columns)?.id === column.id)
          .length,
      }))
      .filter((entry) => entry.count > 0);
  }, [cards, columns, source.id]);
  const total = columnCounts.reduce((sum, entry) => sum + entry.count, 0);
  const Icon = kanbanSourceKindIcon(source.kind);
  const syncStatus = resolveOverviewSyncStatus(source, t);

  return (
    <Pressable
      style={styles.summaryRow}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={source.name}
      testID={`kanban-overview-source-${source.id}`}
    >
      <View style={styles.summaryRowHeader}>
        <View style={styles.summaryRowHeaderIcon}>
          <Icon size={16} color={styles.summaryRowIconColor.color} />
        </View>
        <Text style={styles.summaryRowTitle} numberOfLines={1}>
          {source.name}
        </Text>
        {source.lastSyncError ? <View style={styles.summaryRowErrorDot} /> : null}
        <Text style={styles.summaryRowTotal}>{total}</Text>
      </View>
      <Text
        style={source.lastSyncError ? styles.summaryRowSyncError : styles.summaryRowSync}
        numberOfLines={1}
      >
        {syncStatus}
      </Text>
      {columnCounts.length > 0 ? (
        <View style={styles.summaryChips}>
          {columnCounts.map(({ column, count }) => (
            <View key={column.id} style={styles.summaryChip}>
              <Text style={styles.summaryChipLabel} numberOfLines={1}>
                {column.title}
              </Text>
              <Text style={styles.summaryChipCount}>{count}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

function isStaleCard(card: StoredKanbanCard, columns: KanbanColumn[]): boolean {
  const column = resolveCardColumn(card, columns);
  if (column && TERMINAL_LEGACY_STATUSES.has(column.legacyStatus)) {
    return false;
  }
  const updatedMs = Date.parse(card.updatedAt);
  if (Number.isNaN(updatedMs)) {
    return false;
  }
  return Date.now() - updatedMs > STALE_CARD_MS;
}

// Two board-wide counts with no clean home in the existing filter dimensions
// (search/source/assignee/date-range — see use-kanban-card-filters.ts), so
// these are display-only, not click-to-filter, per product instruction: don't
// invent a new filter dimension just to make a stat clickable.
function KanbanOverviewFocusRow({
  cards,
  columns,
}: {
  cards: StoredKanbanCard[];
  columns: KanbanColumn[];
}): ReactElement {
  const { t } = useTranslation();
  const unresolvedCount = useMemo(
    () => cards.filter((card) => card.hasUnresolvedThreads).length,
    [cards],
  );
  const staleCount = useMemo(
    () => cards.filter((card) => isStaleCard(card, columns)).length,
    [cards, columns],
  );

  return (
    <View style={styles.focusRow} testID="kanban-overview-focus">
      <View style={styles.focusStat} testID="kanban-overview-focus-unresolved">
        <Text style={styles.focusStatValue}>{unresolvedCount}</Text>
        <Text style={styles.focusStatLabel}>{t("kanban.overview.unresolvedThreads")}</Text>
      </View>
      <View style={styles.focusStat} testID="kanban-overview-focus-stale">
        <Text style={styles.focusStatValue}>{staleCount}</Text>
        <Text style={styles.focusStatLabel}>{t("kanban.overview.stale")}</Text>
      </View>
    </View>
  );
}

interface KanbanBoardAreaProps {
  cards: ReturnType<typeof useKanbanCards>["cards"];
  columns: KanbanColumn[];
  columnsSupported: boolean;
  serverId: string | null;
  cardDetailSupported: boolean;
  mutations: ReturnType<typeof useKanbanMutations>;
  columnMutations: ReturnType<typeof useKanbanColumnMutations>;
  sources: StoredKanbanSource[];
  onCreate: () => void;
  // Manual cards only ever show in Overview (see the KanbanBoardTab doc) —
  // the Add CTA in a kind tab's empty state would be a dead end.
  showAddCta: boolean;
  SourceView: ReturnType<typeof resolveKanbanSourceView>;
}

function KanbanBoardArea({
  cards,
  columns,
  columnsSupported,
  serverId,
  cardDetailSupported,
  mutations,
  columnMutations,
  sources,
  onCreate,
  showAddCta,
  SourceView,
}: KanbanBoardAreaProps): ReactElement {
  const { t } = useTranslation();

  if (cards.length > 0) {
    return (
      <SourceView
        cards={cards}
        columns={columns}
        columnsSupported={columnsSupported}
        serverId={serverId}
        cardDetailSupported={cardDetailSupported}
        mutations={mutations}
        columnMutations={columnMutations}
        sources={sources}
      />
    );
  }

  return (
    <View style={styles.centered}>
      <View style={styles.emptyState} testID="kanban-empty">
        <SquareKanban size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
        <Text style={styles.emptyTitle}>{t("kanban.empty")}</Text>
        {showAddCta ? (
          <Button
            variant="outline"
            leftIcon={Plus}
            onPress={onCreate}
            size="sm"
            testID="kanban-empty-add"
          >
            {t("kanban.actions.add")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  tabsRow: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  overviewSection: {
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[3],
  },
  // Horizontal card row on wide screens, stacked on compact — same
  // breakpoint pattern as the row paddings above.
  overviewSummaryList: {
    flexDirection: { xs: "column", md: "row" },
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  summaryRow: {
    flexGrow: 1,
    flexBasis: { xs: "100%", md: 260 },
    minWidth: 220,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  summaryRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summaryRowHeaderIcon: {
    alignItems: "center",
    justifyContent: "center",
  },
  summaryRowIconColor: {
    color: theme.colors.foregroundMuted,
  },
  summaryRowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  summaryRowErrorDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
  },
  summaryRowTotal: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  summaryRowSync: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  summaryRowSyncError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
  summaryChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  summaryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  summaryChipLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  summaryChipCount: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  focusRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  focusStat: {
    flexGrow: 1,
    flexBasis: 160,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[1],
  },
  focusStatValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  focusStatLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  syncFailedToastText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
  // Static color holder read by the spinner (no useUnistyles in new code).
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
}));
