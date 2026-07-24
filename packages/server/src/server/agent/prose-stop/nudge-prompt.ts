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
    "Rule: decisions go through the ask ladder — prefer native AskUserQuestion when reliable,",
    "else MCP ask_question. On timedOut/timeout/unavailable, follow the paseo-ask skill:",
    "`paseo question wait <questionId>` (same inbox id) or create+wait. Never re-ask in prose.",
    "User dismiss (dismissed=true) is a real outcome — do not treat it as timeout fallback.",
    "",
    "Fix now: re-ask the same decision with ask_question (≤4 options), or continue with the",
    "next tool call if no decision is required. Do not end the turn waiting in prose again.",
  ].join("\n");
}
