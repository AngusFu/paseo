/** Fixed sidebar prefix for workspaces minted by workflow runs. Not user-editable. */
export const WORKFLOW_WORKSPACE_EMOJI_PREFIX = "⚙️ ";

export function stripWorkflowWorkspaceEmojiPrefix(title: string): string {
  const trimmed = title.trim();
  if (trimmed.startsWith(WORKFLOW_WORKSPACE_EMOJI_PREFIX)) {
    return trimmed.slice(WORKFLOW_WORKSPACE_EMOJI_PREFIX.length).trimStart();
  }
  // Tolerate the emoji without the trailing space.
  if (trimmed.startsWith("⚙️")) {
    return trimmed.slice("⚙️".length).trimStart();
  }
  return trimmed;
}

/** Ensure a workflow workspace title always starts with the locked emoji prefix. */
export function formatWorkflowWorkspaceTitle(body: string, fallback = "workflow"): string {
  const cleaned = stripWorkflowWorkspaceEmojiPrefix(body);
  const text = cleaned.trim() || fallback.trim() || "workflow";
  return `${WORKFLOW_WORKSPACE_EMOJI_PREFIX}${text}`;
}
