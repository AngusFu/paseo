import { useEffect, useMemo, useState } from "react";
import type {
  KnowledgeBase,
  KnowledgeBaseSearchHit,
  KnowledgeBaseSearchMode,
  KnowledgeBaseTreeNode,
  KnowledgeBaseUsage,
} from "@getpaseo/protocol/knowledge-base/types";
import { useFetchQuery } from "@/data/query";
import {
  resolveKnowledgeBaseDetailApis,
  type KnowledgeBaseGetPageFn,
  type KnowledgeBaseListTreeFn,
  type KnowledgeBaseSearchFn,
} from "@/knowledge-bases/resolve-knowledge-base-detail";
import {
  resolveKnowledgeBasePageAuthoringApis,
  type KnowledgeBaseDeletePageFn,
  type KnowledgeBaseUpsertPageFn,
} from "@/knowledge-bases/resolve-knowledge-base-page-authoring";
import { useKnowledgeBases } from "@/knowledge-bases/use-knowledge-bases";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

export function knowledgeBaseTreeQueryKey(serverId: string, idOrSlug: string) {
  return ["knowledge-bases", "tree", serverId, idOrSlug] as const;
}

export function knowledgeBasePageQueryKey(serverId: string, idOrSlug: string, path: string) {
  return ["knowledge-bases", "page", serverId, idOrSlug, path] as const;
}

export function knowledgeBaseUsagesQueryKey(serverId: string, idOrSlug: string) {
  return ["knowledge-bases", "usages", serverId, idOrSlug] as const;
}

export function knowledgeBaseSearchQueryKey(
  serverId: string,
  idOrSlug: string,
  query: string,
  mode: KnowledgeBaseSearchMode,
) {
  return ["knowledge-bases", "search", serverId, idOrSlug, mode, query] as const;
}

export interface UseKnowledgeBaseDetailApisResult {
  listTree: KnowledgeBaseListTreeFn | null;
  getPage: KnowledgeBaseGetPageFn | null;
  search: KnowledgeBaseSearchFn | null;
  ready: boolean;
}

/** Poll until K2a client methods appear after parallel `build:client`. */
export function useKnowledgeBaseDetailApis(
  client: ReturnType<typeof useHostRuntimeClient>,
): UseKnowledgeBaseDetailApisResult {
  const [apis, setApis] = useState(() => resolveKnowledgeBaseDetailApis(client));

  useEffect(() => {
    setApis(resolveKnowledgeBaseDetailApis(client));
  }, [client]);

  useEffect(() => {
    if (apis.ready) return;
    const timer = setInterval(() => {
      setApis(resolveKnowledgeBaseDetailApis(client));
    }, 2_000);
    return () => clearInterval(timer);
  }, [apis.ready, client]);

  return apis;
}

export interface UseKnowledgeBasePageAuthoringApisResult {
  upsertPage: KnowledgeBaseUpsertPageFn | null;
  deletePage: KnowledgeBaseDeletePageFn | null;
  ready: boolean;
}

/** Poll until K3a upsert/delete client methods appear after parallel `build:client`. */
export function useKnowledgeBasePageAuthoringApis(
  client: ReturnType<typeof useHostRuntimeClient>,
): UseKnowledgeBasePageAuthoringApisResult {
  const [apis, setApis] = useState(() => resolveKnowledgeBasePageAuthoringApis(client));

  useEffect(() => {
    setApis(resolveKnowledgeBasePageAuthoringApis(client));
  }, [client]);

  useEffect(() => {
    if (apis.ready) return;
    const timer = setInterval(() => {
      setApis(resolveKnowledgeBasePageAuthoringApis(client));
    }, 2_000);
    return () => clearInterval(timer);
  }, [apis.ready, client]);

  return apis;
}

export function useKnowledgeBaseRecord(
  serverId: string | null,
  idOrSlug: string,
): {
  knowledgeBase: KnowledgeBase | null;
  supported: boolean;
  listLoading: boolean;
  listError: Error | null;
  refetchList: () => void;
} {
  const { knowledgeBases, loadState, supported, error, refetch } = useKnowledgeBases(serverId);
  const knowledgeBase = useMemo(() => {
    const needle = idOrSlug.trim();
    if (!needle) return null;
    return knowledgeBases.find((kb) => kb.id === needle || kb.slug === needle) ?? null;
  }, [idOrSlug, knowledgeBases]);

  return {
    knowledgeBase,
    supported,
    listLoading: loadState.status !== "loaded",
    listError: error,
    refetchList: refetch,
  };
}

export function useKnowledgeBaseTree(options: {
  serverId: string | null;
  idOrSlug: string;
  listTree: KnowledgeBaseListTreeFn | null;
}): {
  nodes: KnowledgeBaseTreeNode[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { serverId, idOrSlug, listTree } = options;
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && listTree && idOrSlug.trim() && connectionStatus === "online");

  const query = useFetchQuery({
    queryKey: [
      ...knowledgeBaseTreeQueryKey(serverId || "none", idOrSlug || "none"),
      connectionStatus,
      Boolean(listTree),
    ],
    enabled,
    queryFn: async () => {
      if (!listTree) {
        throw new Error("Knowledge base tree API unavailable");
      }
      const payload = await listTree({ idOrSlug });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.nodes;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    nodes: query.data ?? [],
    isLoading: enabled && query.isPending,
    error: query.isError ? query.error : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useKnowledgeBasePage(options: {
  serverId: string | null;
  idOrSlug: string;
  path: string | null;
  getPage: KnowledgeBaseGetPageFn | null;
}): {
  content: string | null;
  path: string | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { serverId, idOrSlug, path, getPage } = options;
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(
    serverId && getPage && idOrSlug.trim() && path?.trim() && connectionStatus === "online",
  );

  const query = useFetchQuery({
    queryKey: [
      ...knowledgeBasePageQueryKey(serverId || "none", idOrSlug || "none", path || "none"),
      connectionStatus,
      Boolean(getPage),
    ],
    enabled,
    queryFn: async () => {
      if (!getPage || !path) {
        throw new Error("Knowledge base page API unavailable");
      }
      const payload = await getPage({ idOrSlug, path });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { path: payload.path, content: payload.content };
    },
    dataShape: "value",
    staleTimeMs: 5_000,
  });

  return {
    content: query.data?.content ?? null,
    path: query.data?.path ?? path,
    isLoading: enabled && query.isPending,
    error: query.isError ? query.error : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useKnowledgeBaseUsages(options: { serverId: string | null; idOrSlug: string }): {
  workspaces: KnowledgeBaseUsage[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { serverId, idOrSlug } = options;
  const client = useHostRuntimeClient(serverId ?? "");
  const supported = useHostFeature(serverId ?? "", "knowledgeBases");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(
    supported && serverId && client && idOrSlug.trim() && connectionStatus === "online",
  );

  const query = useFetchQuery({
    queryKey: [
      ...knowledgeBaseUsagesQueryKey(serverId || "none", idOrSlug || "none"),
      connectionStatus,
    ],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Knowledge base host client unavailable");
      }
      const payload = await client.knowledgeBaseListUsages({ idOrSlug });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.workspaces;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    workspaces: query.data ?? [],
    isLoading: enabled && query.isPending,
    error: query.isError ? query.error : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useKnowledgeBaseSearch(options: {
  serverId: string | null;
  idOrSlug: string;
  query: string;
  mode: KnowledgeBaseSearchMode;
  search: KnowledgeBaseSearchFn | null;
}): {
  hits: KnowledgeBaseSearchHit[];
  isLoading: boolean;
  error: Error | null;
} {
  const { serverId, idOrSlug, query: searchQuery, mode, search } = options;
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const trimmed = searchQuery.trim();
  const enabled = Boolean(
    serverId && search && idOrSlug.trim() && trimmed && connectionStatus === "online",
  );

  const query = useFetchQuery({
    queryKey: [
      ...knowledgeBaseSearchQueryKey(serverId || "none", idOrSlug || "none", trimmed, mode),
      connectionStatus,
      Boolean(search),
    ],
    enabled,
    queryFn: async () => {
      if (!search) {
        throw new Error("Knowledge base search API unavailable");
      }
      const payload = await search({
        idOrSlug,
        query: trimmed,
        mode,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.hits;
    },
    dataShape: "list",
    staleTimeMs: 2_000,
  });

  return {
    hits: trimmed ? (query.data ?? []) : [],
    isLoading: enabled && query.isPending,
    error: query.isError ? query.error : null,
  };
}
