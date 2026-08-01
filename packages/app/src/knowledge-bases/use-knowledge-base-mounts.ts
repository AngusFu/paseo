import type { KnowledgeBaseMount } from "@getpaseo/protocol/knowledge-base/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import type { AggregateLoadState } from "@/schedules/aggregated-schedules";

export const knowledgeBaseMountsQueryBaseKey = ["knowledge-bases", "mounts"] as const;

export function knowledgeBaseMountsQueryKey(serverId: string, workspaceId: string) {
  return [...knowledgeBaseMountsQueryBaseKey, serverId, workspaceId] as const;
}

export interface UseKnowledgeBaseMountsResult {
  loadState: AggregateLoadState<KnowledgeBaseMount>;
  mounts: KnowledgeBaseMount[];
  refetch: () => void;
  isRefetching: boolean;
  supported: boolean;
  /** Set when the first fetch fails (no cached mounts to show). */
  error: Error | null;
}

const EMPTY: KnowledgeBaseMount[] = [];

function resolveMountsLoadState(input: {
  supported: boolean;
  serverId: string;
  workspaceId: string;
  enabled: boolean;
  isPending: boolean;
  isError: boolean;
  data: KnowledgeBaseMount[] | undefined;
}): AggregateLoadState<KnowledgeBaseMount> {
  if (!input.supported || !input.serverId || !input.workspaceId || !input.enabled) {
    return { status: "connecting" };
  }
  if (input.isPending) {
    return { status: "loading" };
  }
  // Failed first fetch must not look like "loaded empty" (false empty-mounts callout).
  if (input.isError && input.data === undefined) {
    return { status: "loading" };
  }
  return { status: "loaded", data: input.data ?? EMPTY };
}

export function useKnowledgeBaseMounts(input: {
  serverId: string | null;
  workspaceId: string | null;
}): UseKnowledgeBaseMountsResult {
  const normalizedServerId = input.serverId?.trim() ?? "";
  const normalizedWorkspaceId = input.workspaceId?.trim() ?? "";
  const supported = useHostFeature(normalizedServerId, "knowledgeBases");
  const client = useHostRuntimeClient(normalizedServerId);
  const connectionStatuses = useHostRuntimeConnectionStatuses(
    normalizedServerId ? [normalizedServerId] : [],
  );
  const connectionStatus = normalizedServerId
    ? (connectionStatuses.get(normalizedServerId) ?? "connecting")
    : "disconnected";
  const isOnline = connectionStatus === "online";
  const enabled = Boolean(
    supported && normalizedServerId && normalizedWorkspaceId && client && isOnline,
  );

  const query = useFetchQuery({
    queryKey: [
      ...knowledgeBaseMountsQueryKey(normalizedServerId || "none", normalizedWorkspaceId || "none"),
      connectionStatus,
    ],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Knowledge base host client unavailable");
      }
      const payload = await client.knowledgeBaseListMounts({
        workspaceId: normalizedWorkspaceId,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.mounts;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  const loadState = resolveMountsLoadState({
    supported,
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    enabled,
    isPending: query.isPending,
    isError: query.isError,
    data: query.data,
  });

  return {
    loadState,
    mounts: loadState.status === "loaded" ? loadState.data : EMPTY,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
    supported,
    error: query.isError && query.data === undefined ? query.error : null,
  };
}
