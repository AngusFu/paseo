import { useEffect, useMemo } from "react";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { refreshProviderSubagents, useProviderSubagentStore } from "./provider-store";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  getWorkflowCallIdFromLabels,
  getWorkflowRunIdFromLabels,
} from "@getpaseo/protocol/agent-labels";

export interface PaseoSubagentRow {
  kind: "paseo";
  id: Agent["id"];
  provider: Agent["provider"];
  title: Agent["title"];
  status: Agent["status"];
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"];
}

export interface ProviderSubagentRow {
  kind: "provider";
  id: string;
  parentAgentId: string;
  provider: ProviderSubagentDescriptorPayload["provider"];
  title: string | null;
  status: ProviderSubagentDescriptorPayload["status"];
  requiresAttention: boolean;
  createdAt: Date;
}

export type SubagentRow = PaseoSubagentRow | ProviderSubagentRow;

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;
type ProviderSubagentStoreSnapshot = ReturnType<typeof useProviderSubagentStore.getState>;

interface SelectSubagentsParams {
  serverId: string;
  parentAgentId: string;
}

const EMPTY_SUBAGENT_ROWS: SubagentRow[] = [];
const EMPTY_PROVIDER_SUBAGENT_ROWS: ProviderSubagentRow[] = [];

function toSubagentRow(agent: Agent): SubagentRow {
  return {
    kind: "paseo",
    id: agent.id,
    provider: agent.provider,
    title: agent.title,
    status: agent.status,
    requiresAttention: agent.requiresAttention,
    createdAt: agent.createdAt,
  };
}

export function selectSubagentsForParent(
  state: SessionStoreSnapshot,
  params: SelectSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
): SubagentRow[] {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  const rows: SubagentRow[] = [];
  for (const agent of agents.values()) {
    if (
      agent.archivedAt ||
      pendingArchiveIds.has(agent.id) ||
      agent.parentAgentId !== params.parentAgentId
    ) {
      continue;
    }
    rows.push(toSubagentRow(agent));
  }

  if (rows.length === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

// Agents spawned by a workflow run, matched via the daemon-stamped
// paseo.workflow-run-id label. Archived agents stay included — a finished
// run's detail view should still list what ran.
export function selectAgentsForWorkflowRun(
  state: SessionStoreSnapshot,
  params: { serverId: string; runId: string },
): SubagentRow[] {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  const rows: SubagentRow[] = [];
  for (const agent of agents.values()) {
    if (getWorkflowRunIdFromLabels(agent.labels) !== params.runId) {
      continue;
    }
    rows.push(toSubagentRow(agent));
  }

  if (rows.length === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

const EMPTY_CALL_ID_AGENTS: Readonly<Record<number, string>> = Object.freeze({});

/**
 * callId → agentId for a run's agents, read off the daemon-stamped
 * `paseo.workflow-call-id` label. This is what makes a *running* progress-tree
 * row clickable — the run's `agent.done` event carries the same pairing, but
 * only after the call finished. Runs from a daemon that predates the label
 * simply resolve nothing here and fall back to the event pairing.
 *
 * A retried call spawns a fresh agent under the same callId; the newest one is
 * the live attempt, so it wins.
 */
export function selectWorkflowRunAgentIdsByCallId(
  state: SessionStoreSnapshot,
  params: { serverId: string; runId: string },
): Readonly<Record<number, string>> {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_CALL_ID_AGENTS;
  }

  const byCallId = new Map<number, Agent>();
  for (const agent of agents.values()) {
    if (getWorkflowRunIdFromLabels(agent.labels) !== params.runId) {
      continue;
    }
    const callId = getWorkflowCallIdFromLabels(agent.labels);
    if (callId === null) {
      continue;
    }
    const existing = byCallId.get(callId);
    if (!existing || existing.createdAt.getTime() <= agent.createdAt.getTime()) {
      byCallId.set(callId, agent);
    }
  }

  if (byCallId.size === 0) {
    return EMPTY_CALL_ID_AGENTS;
  }
  // A plain record keeps the equality check shallow-comparable across polls.
  const result: Record<number, string> = {};
  for (const [callId, agent] of byCallId) {
    result[callId] = agent.id;
  }
  return result;
}

export function useWorkflowRunAgentIdsByCallId(params: {
  serverId: string | null;
  runId: string | null;
}): Readonly<Record<number, string>> {
  const { serverId, runId } = params;
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      serverId && runId
        ? selectWorkflowRunAgentIdsByCallId(state, { serverId, runId })
        : EMPTY_CALL_ID_AGENTS,
    equal,
  );
}

export function useAgentsForWorkflowRun(params: {
  serverId: string | null;
  runId: string | null;
}): SubagentRow[] {
  const { serverId, runId } = params;
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      serverId && runId
        ? selectAgentsForWorkflowRun(state, { serverId, runId })
        : EMPTY_SUBAGENT_ROWS,
    equal,
  );
}

export function selectProviderSubagentsForParent(
  state: ProviderSubagentStoreSnapshot,
  params: SelectSubagentsParams,
  supported: boolean,
): ProviderSubagentRow[] {
  if (!supported) return EMPTY_PROVIDER_SUBAGENT_ROWS;
  const rows: ProviderSubagentRow[] = [];
  const prefix = `${params.serverId}\0${params.parentAgentId}\0`;
  for (const [key, subagent] of state.descriptors) {
    if (!key.startsWith(prefix) || state.hiddenFromTrack.has(key)) continue;
    rows.push({
      kind: "provider",
      id: subagent.id,
      parentAgentId: subagent.parentAgentId,
      provider: subagent.provider,
      title: subagent.title ?? subagent.description,
      status: subagent.status,
      requiresAttention: subagent.status === "failed",
      createdAt: new Date(subagent.createdAt),
    });
  }
  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

export function useSubagentsForParent(params: SelectSubagentsParams): SubagentRow[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  const paseoRows = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSubagentsForParent(state, params, pendingArchiveIds),
    equal,
  );
  const supported = useSessionStore(
    (state) => state.sessions[params.serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const providerRows = useStoreWithEqualityFn(
    useProviderSubagentStore,
    (state) => selectProviderSubagentsForParent(state, params, supported),
    equal,
  );
  const client = useSessionStore((state) => state.sessions[params.serverId]?.client ?? null);

  useEffect(() => {
    if (!client || !supported) return;
    void refreshProviderSubagents(client, params.serverId, params.parentAgentId).catch(
      () => undefined,
    );
  }, [client, params.parentAgentId, params.serverId, supported]);

  return useMemo(() => {
    if (providerRows.length === 0) return paseoRows;
    const rows = [...paseoRows, ...providerRows];
    rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    return rows;
  }, [paseoRows, providerRows]);
}
