import { useMemo, useState, useCallback, useEffect, type ReactElement } from "react";
import { View, Text, TextInput } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, Search, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { useHosts } from "@/runtime/host-runtime";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { isWeb } from "@/constants/platform";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { Theme } from "@/styles/theme";

const ThemedSearch = withUnistyles(Search);
const ThemedTextInput = withUnistyles(TextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function matchesSearch(agent: AggregatedAgent, query: string): boolean {
  const haystack = [
    agent.title,
    agent.projectPlacement?.workspaceName,
    agent.projectPlacement?.checkout.currentBranch,
    agent.projectPlacement?.projectName,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function SessionsSearchField({
  value,
  onChangeText,
  onClear,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const fieldStyle = useMemo(
    () => [styles.searchField, value ? styles.searchFieldActive : null],
    [value],
  );
  return (
    <View style={fieldStyle}>
      <ThemedSearch size={14} uniProps={mutedColorMapping} />
      <ThemedTextInput
        testID="sessions-search-input"
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={t("sessions.search.label")}
        placeholder={t("sessions.search.placeholder")}
        // @ts-expect-error - outlineStyle is web-only
        style={SEARCH_INPUT_STYLE}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {value ? (
        <Button
          variant="ghost"
          size="xs"
          leftIcon={X}
          onPress={onClear}
          accessibilityLabel={t("sessions.search.clear")}
          testID="sessions-search-clear"
        />
      ) : null}
    </View>
  );
}

type SessionsViewState = "loading" | "loadError" | "empty" | "searchEmpty" | "list";

function deriveSessionsViewState(input: {
  isInitialLoad: boolean;
  showLoadError: boolean;
  isEmpty: boolean;
  showSearchEmpty: boolean;
}): SessionsViewState {
  if (input.isInitialLoad) {
    return "loading";
  }
  if (input.showLoadError) {
    return "loadError";
  }
  if (input.isEmpty) {
    return "empty";
  }
  if (input.showSearchEmpty) {
    return "searchEmpty";
  }
  return "list";
}

function SessionsResultsBody({
  viewState,
  theme,
  emptyText,
  handleBack,
  handleRefresh,
  hasMore,
  isLoadingMore,
  loadMore,
  loadedCount,
  searchedAgents,
  isManualRefresh,
  listFooterComponent,
  showHostSuffix,
}: {
  viewState: SessionsViewState;
  theme: Theme;
  emptyText: string;
  handleBack: () => void;
  handleRefresh: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  loadedCount: number;
  searchedAgents: AggregatedAgent[];
  isManualRefresh: boolean;
  listFooterComponent: ReactElement | null;
  showHostSuffix: boolean;
}) {
  const { t } = useTranslation();

  if (viewState === "loading") {
    return (
      <View style={styles.loadingContainer}>
        <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  if (viewState === "loadError") {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Unable to load sessions</Text>
        <Button variant="ghost" onPress={handleRefresh}>
          Try again
        </Button>
      </View>
    );
  }

  if (viewState === "empty") {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{emptyText}</Text>
        <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
          Back
        </Button>
      </View>
    );
  }

  if (viewState === "searchEmpty") {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{t("sessions.searchEmpty.title")}</Text>
        {hasMore ? (
          <>
            <Text style={styles.emptyHint}>
              {t("sessions.searchEmpty.onlyLoaded", { count: loadedCount })}
            </Text>
            <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
              {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
            </Button>
          </>
        ) : null}
      </View>
    );
  }

  return (
    <AgentList
      agents={searchedAgents}
      showCheckoutInfo={false}
      isRefreshing={isManualRefresh}
      onRefresh={handleRefresh}
      listFooterComponent={listFooterComponent}
      showAttentionIndicator={false}
      showHostSuffix={showHostSuffix}
    />
  );
}

export function SessionsScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <SessionsScreenContent />;
}

function SessionsScreenContent() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [searchQuery, setSearchQuery] = useState("");
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const { agents, hasMore, isInitialLoad, isLoadingMore, isError, loadMore, refreshAll } =
    useAgentHistory({
      serverId: historyServerId,
    });

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    void refreshAll().finally(() => setIsManualRefresh(false));
  }, [refreshAll]);

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }, [agents]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const isSearching = normalizedSearch.length > 0;

  const searchedAgents = useMemo(() => {
    if (!isSearching) {
      return sortedAgents;
    }
    return sortedAgents.filter((agent) => matchesSearch(agent, normalizedSearch));
  }, [sortedAgents, isSearching, normalizedSearch]);

  const handleClearSearch = useCallback(() => setSearchQuery(""), []);

  const emptyText =
    selectedHost === ALL_HOSTS_OPTION_ID ? t("sessions.empty") : "No sessions for this host";
  const showHostFilter = hosts.length > 1;
  const showHostSuffix = selectedHost === ALL_HOSTS_OPTION_ID && hosts.length > 1;
  const showLoadError = isError && sortedAgents.length === 0;
  const showSearchEmpty = isSearching && sortedAgents.length > 0 && searchedAgents.length === 0;

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  const listFooterComponent = useMemo(
    () =>
      hasMore ? (
        <View style={styles.footer}>
          <Button variant="ghost" onPress={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? "Loading..." : t("sessions.actions.loadMore")}
          </Button>
        </View>
      ) : null,
    [hasMore, loadMore, isLoadingMore, t],
  );

  const viewState = deriveSessionsViewState({
    isInitialLoad,
    showLoadError,
    isEmpty: sortedAgents.length === 0,
    showSearchEmpty,
  });

  return (
    <View style={styles.container}>
      <MenuHeader title={t("sessions.title")} />
      <View style={styles.filterContainer}>
        <View style={styles.filterRow}>
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={setSelectedHost}
              triggerTestID="sessions-host-filter-trigger"
            />
          ) : null}
          <SessionsSearchField
            value={searchQuery}
            onChangeText={setSearchQuery}
            onClear={handleClearSearch}
          />
        </View>
      </View>
      <SessionsResultsBody
        viewState={viewState}
        theme={theme}
        emptyText={emptyText}
        handleBack={handleBack}
        handleRefresh={handleRefresh}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        loadMore={loadMore}
        loadedCount={sortedAgents.length}
        searchedAgents={searchedAgents}
        isManualRefresh={isManualRefresh}
        listFooterComponent={listFooterComponent}
        showHostSuffix={showHostSuffix}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterContainer: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexGrow: 1,
    minWidth: 160,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  searchFieldActive: {
    borderColor: theme.colors.borderAccent,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  footer: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
}));

const SEARCH_INPUT_STYLE = [styles.searchInput, isWeb && { outlineStyle: "none" as const }];
