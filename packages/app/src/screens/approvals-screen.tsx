import { useMutation } from "@tanstack/react-query";
import { Inbox } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { AskQuestionCard } from "@/components/ask-question-card";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { QuestionFormCard } from "@/components/question-form-card";
import { parseQuestionFormQuestions } from "@/components/question-form-card-core";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import {
  useQuestions,
  type AggregateLoadState,
  type AggregatedQuestion,
  type ApprovalsBucket,
  type QuestionHostError,
} from "@/hooks/use-questions";
import {
  answersFromPermissionResponse,
  toInboxQuestionPermission,
} from "@/questions/inbox-question-permission";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const STATUS_FILTER_OPTIONS: { value: ApprovalsBucket; labelKey: string; testID: string }[] = [
  { value: "pending", labelKey: "approvals.filter.pending", testID: "approvals-filter-pending" },
  {
    value: "answered",
    labelKey: "approvals.filter.answered",
    testID: "approvals-filter-answered",
  },
  {
    value: "closed",
    labelKey: "approvals.filter.closed",
    testID: "approvals-filter-closed",
  },
];

const EMPTY_QUESTIONS: AggregatedQuestion[] = [];

export function ApprovalsScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <ApprovalsScreenContent />;
}

function ApprovalsScreenContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selectedHost, setSelectedHost] = useState(ALL_HOSTS_OPTION_ID);
  const [statusFilter, setStatusFilter] = useState<ApprovalsBucket>("pending");
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const historyServerId = selectedHost === ALL_HOSTS_OPTION_ID ? null : selectedHost;
  const { loadState, hostErrors, isError, refetch, hasMore, isLoadingMore, loadMore } =
    useQuestions({
      bucket: statusFilter,
      serverId: historyServerId,
    });
  const questions = loadState.status === "loaded" ? loadState.data : EMPTY_QUESTIONS;
  const { agents } = useAggregatedAgents({ includeArchived: true });

  useEffect(() => {
    if (
      selectedHost !== ALL_HOSTS_OPTION_ID &&
      !hosts.some((host) => host.serverId === selectedHost)
    ) {
      setSelectedHost(ALL_HOSTS_OPTION_ID);
    }
  }, [hosts, selectedHost]);

  const agentTitleByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      map.set(`${agent.serverId}:${agent.id}`, agent.title || agent.id);
    }
    return map;
  }, [agents]);

  const filtered = questions;

  useEffect(() => {
    if (activeQuestionId && !filtered.some((question) => question.id === activeQuestionId)) {
      setActiveQuestionId(null);
    }
  }, [activeQuestionId, filtered]);

  const toggleQuestion = useCallback((questionId: string) => {
    setActiveQuestionId((current) => (current === questionId ? null : questionId));
  }, []);

  const showHostFilter = hosts.length > 1;

  return (
    <View style={styles.container} testID="approvals-screen">
      <MenuHeader title={t("approvals.title")} />
      <ApprovalsScreenBody
        rows={filtered}
        loadState={loadState}
        hostErrors={hostErrors}
        showLoadError={isError}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        showHostFilter={showHostFilter}
        hosts={hosts}
        selectedHost={selectedHost}
        onSelectHost={setSelectedHost}
        onRetry={refetch}
        agentTitleByKey={agentTitleByKey}
        activeQuestionId={activeQuestionId}
        onToggleQuestion={toggleQuestion}
        onAnswered={refetch}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={loadMore}
      />
    </View>
  );
}

function ApprovalsScreenBody({
  rows,
  loadState,
  hostErrors,
  showLoadError,
  statusFilter,
  onStatusFilterChange,
  showHostFilter,
  hosts,
  selectedHost,
  onSelectHost,
  onRetry,
  agentTitleByKey,
  activeQuestionId,
  onToggleQuestion,
  onAnswered,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: {
  rows: AggregatedQuestion[];
  loadState: AggregateLoadState<AggregatedQuestion>;
  hostErrors: QuestionHostError[];
  showLoadError: boolean;
  statusFilter: ApprovalsBucket;
  onStatusFilterChange: (value: ApprovalsBucket) => void;
  showHostFilter: boolean;
  hosts: ReturnType<typeof useHosts>;
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  onRetry: () => void;
  agentTitleByKey: ReadonlyMap<string, string>;
  activeQuestionId: string | null;
  onToggleQuestion: (questionId: string) => void;
  onAnswered: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const statusOptions = useMemo(
    () =>
      STATUS_FILTER_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
        testID: option.testID,
      })),
    [t],
  );

  if (loadState.status === "connecting" || loadState.status === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  if (showLoadError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("approvals.list.loadError")}</Text>
        <Button variant="ghost" onPress={onRetry} testID="approvals-retry">
          {t("approvals.list.tryAgain")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <View style={styles.filterRow}>
        <View style={styles.filterRowControls}>
          {showHostFilter ? (
            <HostFilter
              hosts={hosts}
              selectedHost={selectedHost}
              onSelectHost={onSelectHost}
              triggerTestID="approvals-host-filter-trigger"
            />
          ) : null}
          <SegmentedControl
            size="sm"
            value={statusFilter}
            onValueChange={onStatusFilterChange}
            options={statusOptions}
            testID="approvals-status-filter"
          />
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="approvals-list"
      >
        {hostErrors.length > 0 ? <QuestionHostErrorsBanner errors={hostErrors} /> : null}
        {rows.length === 0 ? (
          <ApprovalsEmptyState bucket={statusFilter} />
        ) : (
          rows.map((question) => (
            <ApprovalsQuestionRow
              key={`${question.serverId}:${question.id}`}
              question={question}
              agentTitle={
                agentTitleByKey.get(`${question.serverId}:${question.agentId}`) ?? question.agentId
              }
              isActive={activeQuestionId === question.id}
              onToggle={onToggleQuestion}
              onAnswered={onAnswered}
            />
          ))
        )}
        {hasMore ? (
          <Button
            variant="ghost"
            onPress={onLoadMore}
            disabled={isLoadingMore}
            testID="approvals-load-more"
          >
            {isLoadingMore ? t("common.loading") : t("sessions.actions.loadMore")}
          </Button>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ApprovalsQuestionRow({
  question,
  agentTitle,
  isActive,
  onToggle,
  onAnswered,
}: {
  question: AggregatedQuestion;
  agentTitle: string;
  isActive: boolean;
  onToggle: (questionId: string) => void;
  onAnswered: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const runtime = getHostRuntimeStore();
  const permission = useMemo(() => toInboxQuestionPermission(question), [question]);
  const formQuestions = useMemo(
    () => parseQuestionFormQuestions(permission.request.input) ?? [],
    [permission.request.input],
  );
  const preview = question.title ?? question.questions[0]?.question ?? question.id;
  const isPending = question.status === "pending";
  const resolvedCardStatus =
    question.status === "dismissed" || question.status === "expired"
      ? ("canceled" as const)
      : ("completed" as const);

  const answerMutation = useMutation({
    mutationFn: async (response: AgentPermissionResponse) => {
      const client = runtime.getClient(question.serverId);
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const settlement = answersFromPermissionResponse(response);
      const payload =
        "dismiss" in settlement
          ? await client.questionAnswer({ questionId: question.id, dismiss: true })
          : await client.questionAnswer({
              questionId: question.id,
              answers: settlement.answers,
            });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    onSuccess: () => {
      onAnswered();
    },
  });

  const handleRespond = useCallback(
    (response: AgentPermissionResponse) => {
      answerMutation.mutate(response);
    },
    [answerMutation],
  );

  const handleOpenAgent = useCallback(() => {
    navigateToAgent({
      serverId: question.serverId,
      agentId: question.agentId,
      workspaceId: question.workspaceId,
    });
  }, [question.agentId, question.serverId, question.workspaceId]);

  const handleSelect = useCallback(() => {
    onToggle(question.id);
  }, [onToggle, question.id]);

  return (
    <View
      style={[styles.row, isActive && styles.rowActive]}
      testID={`approvals-row-${question.id}`}
    >
      <Pressable
        onPress={handleSelect}
        style={styles.rowHeader}
        testID={`approvals-row-toggle-${question.id}`}
      >
        <View style={styles.rowHeaderText}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {preview}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {t("approvals.row.meta", {
              agent: agentTitle,
              host: question.serverName,
              source: question.source,
            })}
          </Text>
        </View>
        <Text style={styles.rowStatus}>{t(`approvals.status.${question.status}`)}</Text>
      </Pressable>

      {isActive ? (
        <View style={styles.rowBody}>
          <Button
            variant="ghost"
            size="sm"
            onPress={handleOpenAgent}
            testID={`approvals-open-agent-${question.id}`}
          >
            {t("approvals.row.openAgent")}
          </Button>
          {isPending ? (
            <QuestionFormCard
              permission={permission}
              onRespond={handleRespond}
              isResponding={answerMutation.isPending}
            />
          ) : (
            <AskQuestionCard
              questions={formQuestions}
              result={question.answers}
              status={resolvedCardStatus}
              disableOuterSpacing
            />
          )}
          {answerMutation.isError ? (
            <Text style={styles.errorText}>
              {answerMutation.error instanceof Error
                ? answerMutation.error.message
                : t("approvals.list.answerError")}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function emptyCopyKeys(bucket: ApprovalsBucket): {
  titleKey: string;
  descriptionKey: string;
} {
  if (bucket === "pending") {
    return {
      titleKey: "approvals.empty.pendingTitle",
      descriptionKey: "approvals.empty.pendingDescription",
    };
  }
  if (bucket === "answered") {
    return {
      titleKey: "approvals.empty.answeredTitle",
      descriptionKey: "approvals.empty.answeredDescription",
    };
  }
  return {
    titleKey: "approvals.empty.closedTitle",
    descriptionKey: "approvals.empty.closedDescription",
  };
}

function ApprovalsEmptyState({ bucket }: { bucket: ApprovalsBucket }): ReactElement {
  const { t } = useTranslation();
  const { titleKey, descriptionKey } = emptyCopyKeys(bucket);
  return (
    <View style={styles.emptyState} testID="approvals-empty">
      <Inbox size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <View style={styles.emptyTextStack}>
        <Text style={styles.emptyTitle}>{t(titleKey)}</Text>
        <Text style={styles.emptyDescription}>{t(descriptionKey)}</Text>
      </View>
    </View>
  );
}

function QuestionHostErrorsBanner({ errors }: { errors: QuestionHostError[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.hostErrors} testID="approvals-host-errors">
      {errors.map((error) => (
        <Text key={error.serverId} style={styles.hostErrorText}>
          {t("approvals.list.hostError", {
            serverName: error.serverName,
          })}
        </Text>
      ))}
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
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  filterRowControls: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[12],
    paddingHorizontal: theme.spacing[4],
  },
  emptyIcon: {
    width: 36,
    color: theme.colors.foregroundMuted,
  },
  emptyTextStack: {
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: 360,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  emptyDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  row: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  rowActive: {
    borderColor: theme.colors.borderAccent,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  rowHeaderText: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "capitalize",
  },
  rowBody: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  hostErrors: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  hostErrorText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
