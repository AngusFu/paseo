import { useEffect, useState, type ReactElement } from "react";
import { KnowledgeBaseMountsSheet } from "@/components/knowledge-bases/knowledge-base-mounts-sheet";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  useKnowledgeBaseMountsSheetRequestStore,
  type KnowledgeBaseMountsSheetRequest,
} from "@/stores/knowledge-base-mounts-sheet-request-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

/**
 * Host-level listener for detail → workspace mounts-sheet deep-links.
 * Consumes the request into local open state so the sheet survives clear-after-open.
 */
export function KnowledgeBaseMountsSheetHost(): ReactElement | null {
  const request = useKnowledgeBaseMountsSheetRequestStore((state) => state.request);
  const clearRequest = useKnowledgeBaseMountsSheetRequestStore((state) => state.clearRequest);
  const [open, setOpen] = useState<KnowledgeBaseMountsSheetRequest | null>(null);

  useEffect(() => {
    if (!request) {
      return;
    }
    setOpen(request);
    clearRequest();
  }, [clearRequest, request]);

  const handleClose = useStableEvent(() => {
    setOpen(null);
  });

  const workspaceName = useWorkspaceFields(
    open?.serverId ?? null,
    open?.workspaceId ?? null,
    (workspace) => {
      const title = workspace.title?.trim();
      if (title) {
        return title;
      }
      return workspace.name?.trim() || workspace.id;
    },
  );

  if (!open) {
    return null;
  }

  return (
    <KnowledgeBaseMountsSheet
      key={`${open.id}:${open.workspaceId}`}
      serverId={open.serverId}
      workspaceId={open.workspaceId}
      workspaceName={workspaceName ?? open.workspaceId}
      visible
      onClose={handleClose}
    />
  );
}
