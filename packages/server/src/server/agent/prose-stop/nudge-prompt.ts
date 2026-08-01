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
    "`paseo question wait <questionId>` (same inbox id) or create+wait. Never re-ask in prose,",
    "and do not call ask_question again when you already have a timedOut questionId.",
    "User dismiss (dismissed=true) is a real outcome — do not treat it as timeout fallback.",
    "",
    "Fix now: if you have no open question yet, call ask_question (≤4 options); if MCP already",
    "returned timedOut with questionId, wait that id. Or continue with the next tool call if no",
    "decision is required. Do not end the turn waiting in prose again.",
  ].join("\n");
}

/**
 * Short warning after a full nudge already fired this cycle — still waiting in prose.
 * Avoids silent reentry allow without starting another full nudge loop.
 */
export function formatProseStopReentryWarningPrompt(args?: {
  pattern?: string;
  source?: string;
}): string {
  const detail =
    args?.pattern != null && args.pattern.length > 0
      ? `Matched /${args.pattern}/ (${args.source ?? "regex"}).`
      : "";

  return [
    "⚠️ prose-stop: still waiting in chat prose after the previous nudge.",
    detail,
    "Use ask_question (or native Q UI), or finish without asking the user in prose.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
