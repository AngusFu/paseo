import { i18n } from "@/i18n/i18next";
import type { AggregateLoadState } from "@/schedules/aggregated-schedules";
import type { KnowledgeBaseMount } from "@getpaseo/protocol/knowledge-base/types";

export interface EmptyMountsCalloutTarget {
  serverId: string;
  workspaceId: string;
}

export interface EmptyMountsCalloutPolicy {
  id: string;
  dismissalKey: string;
  priority: number;
  title: string;
  description: string;
  actionLabel: string;
  testID: string;
  serverId: string;
  workspaceId: string;
}

export function shouldShowEmptyMountsCallout(input: {
  supported: boolean;
  loadState: AggregateLoadState<KnowledgeBaseMount>;
}): boolean {
  if (!input.supported) {
    return false;
  }
  if (input.loadState.status !== "loaded") {
    return false;
  }
  return input.loadState.data.length === 0;
}

export function buildEmptyMountsCalloutPolicy(
  target: EmptyMountsCalloutTarget,
): EmptyMountsCalloutPolicy {
  const calloutKey = `knowledge-bases-empty-mounts:${target.serverId}:${target.workspaceId}`;

  return {
    id: calloutKey,
    dismissalKey: calloutKey,
    priority: 90,
    title: i18n.t("sidebar.knowledgeBasesEmpty.title"),
    description: i18n.t("sidebar.knowledgeBasesEmpty.description"),
    actionLabel: i18n.t("sidebar.knowledgeBasesEmpty.mount"),
    testID: `knowledge-bases-empty-mounts-callout-${target.workspaceId}`,
    serverId: target.serverId,
    workspaceId: target.workspaceId,
  };
}
