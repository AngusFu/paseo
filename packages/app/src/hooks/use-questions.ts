import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  fetchAggregatedQuestionsPage,
  getNextQuestionsPageParam,
  questionsQueryBaseKey,
  type AggregateLoadState,
  type AggregatedQuestion,
  type ApprovalsBucket,
  type FetchAggregatedQuestionsResult,
  type QuestionHostError,
  type QuestionHostInput,
} from "@/questions/aggregated-questions";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

export type { AggregateLoadState, AggregatedQuestion, ApprovalsBucket, QuestionHostError };

export function questionsQueryKey(serverIds: readonly string[], bucket: ApprovalsBucket) {
  return [...questionsQueryBaseKey, bucket, [...serverIds].sort().join("|")] as const;
}

export interface UseQuestionsResult {
  loadState: AggregateLoadState<AggregatedQuestion>;
  hostErrors: QuestionHostError[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

export function useQuestions(options: {
  bucket: ApprovalsBucket;
  serverId?: string | null;
}): UseQuestionsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const serverId = useMemo(() => {
    const value = options.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options.serverId]);

  const hostInputs = useMemo<QuestionHostInput[]>(() => {
    const filtered = serverId ? hosts.filter((host) => host.serverId === serverId) : hosts;
    return filtered.map((host) => ({ serverId: host.serverId, serverName: host.label }));
  }, [hosts, serverId]);

  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () =>
      serverIds
        .map((hostServerId) => connectionStatuses.get(hostServerId) ?? "connecting")
        .join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useInfiniteQuery<
    FetchAggregatedQuestionsResult | { status: "connecting" },
    Error,
    { pages: Array<FetchAggregatedQuestionsResult | { status: "connecting" }> },
    readonly unknown[],
    Record<string, string | null> | null
  >({
    queryKey: [...questionsQueryKey(serverIds, options.bucket), connectionStatusKey],
    enabled: hostInputs.length > 0,
    staleTime: 5_000,
    initialPageParam: null,
    getNextPageParam: (lastPage) =>
      lastPage.status === "loaded" ? getNextQuestionsPageParam(lastPage) : null,
    queryFn: async ({ pageParam }) =>
      fetchAggregatedQuestionsPage({
        hosts: hostInputs,
        runtime,
        bucket: options.bucket,
        cursorByServerId: pageParam,
      }),
  });

  const firstPage = query.data?.pages[0];
  let loadState: AggregateLoadState<AggregatedQuestion>;
  if (firstPage?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.pages.some((page) => page.status === "loaded")) {
    const data = (query.data?.pages ?? []).flatMap((page) =>
      page.status === "loaded" ? page.data : [],
    );
    loadState = { status: "loaded", data };
  } else {
    loadState = { status: "loading" };
  }

  const hostErrors = useMemo(() => {
    const errors: QuestionHostError[] = [];
    for (const page of query.data?.pages ?? []) {
      if (page.status === "loaded") {
        errors.push(...page.hostErrors);
      }
    }
    return errors;
  }, [query.data?.pages]);

  const loadMore = useCallback(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) {
      return;
    }
    void query.fetchNextPage();
  }, [query]);

  return {
    loadState,
    hostErrors,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
    hasMore: query.hasNextPage ?? false,
    isLoadingMore: query.isFetchingNextPage,
    loadMore,
  };
}
