/**
 * Names a workflow run's workspace after the prompt it was dispatched with.
 *
 * Ticket links win over prose: a run started from a Jira URL is far easier to
 * find in the sidebar as `SCIF-5129` than as the first line of its prompt.
 * Everything else falls back to the prompt text itself.
 */

/**
 * Max chars of prompt text kept as a workspace name. Workspace titles have no
 * schema limit (they are display strings, never directory names), so this
 * mirrors the derived-agent-title clamp in `create-agent-title.ts` to keep
 * sidebar rows readable.
 */
export const MAX_WORKFLOW_WORKSPACE_NAME_CHARS = 60;

// The host half is matched case-insensitively (people paste
// `Https://MDPI.Atlassian.net/...`); the ticket key is not — Jira project keys
// are uppercase, and `[A-Z][A-Z\d]+-\d+` is the rule we were given. The leading
// `(?:^|[^\w-])` keeps `notatlassian.net` from matching.
const JIRA_BROWSE_URL = /(?:^|[^\w-])(?:[\w-]+\.)*atlassian\.net\/browse\/([\w-]+-\d+)/gi;
const JIRA_TICKET_KEY = /^[A-Z][A-Z\d]+-\d+$/;

/** First Jira ticket id linked anywhere in the text, or null. First link wins. */
export function extractJiraTicketId(text: string): string | null {
  for (const match of text.matchAll(JIRA_BROWSE_URL)) {
    const key = match[1];
    if (key && JIRA_TICKET_KEY.test(key)) {
      return key;
    }
  }
  return null;
}

/**
 * Workspace name for a prompt: the linked Jira ticket id when there is one,
 * otherwise the prompt's first non-empty line clamped to a readable length.
 * Returns null for an empty prompt so callers keep their own fallback.
 */
export function workflowWorkspaceNameFromPrompt(prompt: string | null | undefined): string | null {
  const text = prompt?.trim();
  if (!text) {
    return null;
  }
  const ticket = extractJiraTicketId(text);
  if (ticket) {
    return ticket;
  }
  const firstContentLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstContentLine) {
    return null;
  }
  const clamped = firstContentLine
    .replace(/\s+/g, " ")
    .slice(0, MAX_WORKFLOW_WORKSPACE_NAME_CHARS)
    .trim();
  return clamped || null;
}
