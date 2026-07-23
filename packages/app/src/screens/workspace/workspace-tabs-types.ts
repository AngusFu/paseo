import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export interface WorkspaceTabDescriptor {
  key: string;
  tabId: string;
  kind: WorkspaceTabTarget["kind"];
  target: WorkspaceTabTarget;
  /** Pinned tabs sort to the front and are skipped by the bulk-close actions. */
  pinned?: boolean;
}
