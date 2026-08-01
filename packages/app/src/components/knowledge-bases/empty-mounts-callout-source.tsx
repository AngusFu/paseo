import { useEffect, useMemo, useState } from "react";
import { KnowledgeBaseMountsSheet } from "@/components/knowledge-bases/knowledge-base-mounts-sheet";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  buildEmptyMountsCalloutPolicy,
  shouldShowEmptyMountsCallout,
} from "@/knowledge-bases/empty-mounts-callout-policy";
import { useKnowledgeBaseMounts } from "@/knowledge-bases/use-knowledge-base-mounts";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

export function EmptyMountsCalloutSource() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const workspaceName = useWorkspaceFields(serverId, workspaceId, (workspace) => {
    const title = workspace.title?.trim();
    if (title) {
      return title;
    }
    return workspace.name?.trim() || workspaceId || "";
  });
  const { loadState, supported } = useKnowledgeBaseMounts({ serverId, workspaceId });
  const callouts = useSidebarCallouts();
  const [isMountsSheetOpen, setIsMountsSheetOpen] = useState(false);

  const calloutPolicy = useMemo(() => {
    if (!serverId || !workspaceId) {
      return null;
    }
    if (!shouldShowEmptyMountsCallout({ supported, loadState })) {
      return null;
    }
    return buildEmptyMountsCalloutPolicy({ serverId, workspaceId });
  }, [loadState, serverId, supported, workspaceId]);

  const openMountsSheet = useStableEvent(() => {
    setIsMountsSheetOpen(true);
  });
  const closeMountsSheet = useStableEvent(() => {
    setIsMountsSheetOpen(false);
  });

  useEffect(() => {
    if (!calloutPolicy) {
      return;
    }

    return callouts.show({
      id: calloutPolicy.id,
      dismissalKey: calloutPolicy.dismissalKey,
      priority: calloutPolicy.priority,
      title: calloutPolicy.title,
      description: calloutPolicy.description,
      actions: [{ label: calloutPolicy.actionLabel, onPress: openMountsSheet, variant: "primary" }],
      testID: calloutPolicy.testID,
    });
  }, [calloutPolicy, callouts, openMountsSheet]);

  useEffect(() => {
    setIsMountsSheetOpen(false);
  }, [serverId, workspaceId]);

  if (!serverId || !workspaceId || !supported || !isMountsSheetOpen) {
    return null;
  }

  return (
    <KnowledgeBaseMountsSheet
      key={workspaceId}
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceName={workspaceName ?? workspaceId}
      visible={isMountsSheetOpen}
      onClose={closeMountsSheet}
    />
  );
}
