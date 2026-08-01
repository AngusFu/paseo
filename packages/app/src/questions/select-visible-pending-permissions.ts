import type { PendingPermission } from "@/types/shared";

/**
 * Inbox ask_question / skill-create permission ids. Plan-execute CTAs use a
 * different prefix and must stay independently visible.
 */
export function isInboxQuestionPermissionRequestId(requestId: string): boolean {
  return requestId.startsWith("mcp-question-") || requestId.startsWith("inbox-question-");
}

/**
 * After an MCP ask_question timeout the orphaned form stays pending so skill
 * wait can settle the same id. Agents often re-ask anyway and stack a second
 * identical form. Keep only the newest inbox question form; leave tool /
 * plan-execute permissions untouched.
 */
export function selectVisiblePendingPermissions(
  permissions: readonly PendingPermission[],
): PendingPermission[] {
  let latestInboxQuestion: PendingPermission | null = null;
  const rest: PendingPermission[] = [];
  for (const permission of permissions) {
    if (
      permission.request.kind === "question" &&
      isInboxQuestionPermissionRequestId(permission.request.id)
    ) {
      latestInboxQuestion = permission;
      continue;
    }
    rest.push(permission);
  }
  if (!latestInboxQuestion) {
    return rest;
  }
  return [...rest, latestInboxQuestion];
}
