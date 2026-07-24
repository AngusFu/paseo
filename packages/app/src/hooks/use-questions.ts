import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import {
  fetchAggregatedQuestions,
  questionsQueryBaseKey,
  type AggregateLoadState,
  type AggregatedQuestion,
  type QuestionHostError,
  type QuestionHostInput,
} from "@/questions/aggregated-questions";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

export type { AggregateLoadState, AggregatedQuestion, QuestionHostError };

export function questionsQueryKey(serverIds: readonly string[]) {
  return [...questionsQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseQuestionsResult {
  loadState: AggregateLoadState<AggregatedQuestion>;
  hostErrors: QuestionHostError[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

export function useQuestions(): UseQuestionsResult {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const hostInputs = useMemo<QuestionHostInput[]>(
    () => hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts],
  );
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useFetchQuery({
    queryKey: [...questionsQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedQuestions({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: AggregateLoadState<AggregatedQuestion>;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : [],
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
