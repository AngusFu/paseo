/**
 * System nudge body when prose-stop blocks a waiting-for-user closing.
 * Wrapped by formatSystemNotificationPrompt at the call site.
 */
export function formatProseStopNudgePrompt(args?: { pattern?: string; source?: string }): string {
  const detail =
    args?.pattern != null && args.pattern.length > 0
      ? `Matched pattern /${args.pattern}/ (source=${args.source ?? "regex"}).`
      : `Source=${args?.source ?? "unknown"}.`;

  return [
    "🚧 prose-stop: your last message ended by waiting for the user in chat prose.",
    detail,
    "",
    "Rule: any question that needs a user decision MUST go via the ask_question MCP tool",
    '(or AskUserQuestion), not chat prose such as "let me know", "要…吗?", or "要 push 即可".',
    "",
    "Fix now: re-ask the same decision with ask_question (≤4 options), or continue with the",
    "next tool call if no decision is required. Do not end the turn waiting in prose again.",
  ].join("\n");
}
